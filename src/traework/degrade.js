// src/traework/degrade.js - 额度/升级错误的显式降级编排（调研 P0-3）
//
// **默认关闭**，只有管理端显式开启运行态配置才生效；每次降级都通过
// `X-Trae-Degraded` 响应头告知调用方，绝不静默换模型。
//
// 第一性原理：降级不是「失败重试」，是「换一份请求语义再试」。两条前置：
//   1. 只对**确定**的额度耗尽 / 订阅升级错误降级；限流（429/soft）、
//      网络失败、参数错误、内容审核都不降级——那些换模型只会掩盖主故障。
//   2. 第一尝试一旦吐出过任何内容就不能降级：客户端已经收到半段回答，
//      再补一段会变成两段拼接。判据由 send 的回调计数给出。
//
// API Key 的区域绑定优先于 fallbackRegion：key 已经限死 cn/intl 时，
// 降级只换模型、不越区域（否则等于用开关绕过鉴权约束）。
const { classify, traeCodeOf, traeCodeKind, unescapeDeep } = require('../upstream-errors');

const QUOTA_TEXT = /(额度|积分|余额|credits?|quota)[^\n]{0,20}(不足|耗尽|用完|insufficient|exhausted)|(?:3003|3004|4008)\b/i;
const UPGRADE_TEXT = /subscription[- ]only|订阅专享|需(?:要)?升级|upgrade[_ -]?required|\b1005\b|套餐(?:不支持|未包含)/i;

/** 错误 → 降级原因；null = 不适用。只认确有证据的类别，不猜关键词 */
function reasonOf(err) {
  if (!err) return null;
  const raw = unescapeDeep(String(err.message || err.error || err || ''));
  const status = Number(err.statusCode || err.status) || 0;
  const code = traeCodeOf(raw);
  const codeKind = code != null ? traeCodeKind(code) : null;
  const cls = classify({ status: status || code || 0, message: raw });

  // 额度：402、HARD_TEXT、TRAE 额度码 3003/3004/4008，或 classify 判 hard
  if (status === 402 || codeKind === 'quota' || cls.kind === 'hard' || QUOTA_TEXT.test(raw)) return 'quota';
  // 升级：业务码 1005 / 订阅专享 / upgrade_required；403+模型不可用**不算**
  // （那也可能是账号级不可用，换模型不等于升级）
  if (codeKind === 'model' || UPGRADE_TEXT.test(raw)) return 'upgrade';
  return null;
}

/** 剥掉通道前缀，保留前缀形态（模块直调时 payload.model 可能带 traework/） */
function splitModel(raw) {
  const s = String(raw || '');
  const m = /^(traework|traebao)\/(.*)$/.exec(s);
  return m ? { prefix: `${m[1]}/`, name: m[2] } : { prefix: '', name: s };
}

/**
 * 纯函数：按配置与错误算降级计划。返回 null = 不降级。
 * @param {object} cfg trae-runtime.Load().degrade
 * @param {Error} err 第一尝试的错误
 * @param {object} ctx { model, region, persona, tried }
 */
function plan(cfg, err, ctx = {}) {
  if (!cfg || cfg.enabled !== true || ctx.tried) return null;
  // TRAE 宝是单一模型身份（免费豁免绑定 deepseek-v4.1-flash），换模型会破坏
  // 身份契约；显式跳过而不是让它撞第二次 400。
  if (ctx.persona) return null;
  const reason = reasonOf(err);
  if (!reason) return null;
  if (reason === 'quota' && cfg.onQuota === false) return null;
  if (reason === 'upgrade' && cfg.onUpgrade === false) return null;

  const { prefix, name } = splitModel(ctx.model);
  const rawFallback = String(cfg.fallbackModel || '').trim();
  const fallbackModel = rawFallback.replace(/^(traework|traebao)\//, '');
  // 经网关时调用方传的前缀已被 router 剥掉（payload.model 是裸名），
  // sendOnce 内部会再剥一次，所以两种形态都能安全送进 provider；
  // 保留原请求的前缀形态，避免把「调用方写的是 traework/glm-5.2」悄悄改成裸名。
  const wantModel = fallbackModel && fallbackModel !== name ? `${prefix}${fallbackModel}` : '';
  // opts.region 非空 = API Key 已绑定区域；绝不越过鉴权约束
  const fallbackRegion = (!ctx.region && (cfg.fallbackRegion === 'cn' || cfg.fallbackRegion === 'intl'))
    && cfg.fallbackRegion !== ctx.region ? cfg.fallbackRegion : '';
  if (!wantModel && !fallbackRegion) return null;
  const parts = [];
  if (wantModel) parts.push(`${name || 'auto'} -> ${fallbackModel}`);
  if (fallbackRegion) parts.push(`region -> ${fallbackRegion}`);
  parts.push(`(${reason})`);
  return {
    reason,
    model: wantModel || ctx.model,
    region: fallbackRegion || ctx.region,
    header: parts.join(' '),
  };
}

/**
 * 余额预警（面板数据面）：只读已查到的余额，余额未知（null）不参与比较。
 * 不在这里打上游——/credits 已经查过一轮，再查一次就是纯浪费且有风控成本。
 */
function warningsOf(cfg, rows) {
  if (!cfg || cfg.enabled !== true || !(Number(cfg.warnBelow) > 0)) return [];
  const out = [];
  for (const r of rows || []) {
    const v = r && r.remain;
    if (v == null || !Number.isFinite(Number(v))) continue;   // 取不到 ≠ 0
    if (Number(v) < Number(cfg.warnBelow)) {
      out.push({
        accountId: r.id,
        account: r.nickname || r.uid || '',
        remain: Number(v),
        message: `剩余额度 ${v} 低于预警线 ${cfg.warnBelow}`,
      });
    }
  }
  return out;
}

module.exports = { reasonOf, plan, warningsOf, splitModel, QUOTA_TEXT, UPGRADE_TEXT };
