// src/workbuddy/output-probe.js - 模型输出上限实测探针（M2.5）
//
// 出处：workbuddy2api-panel 的 scripts/probe_max_tokens.py——实测 16 个 CN
// 模型里 8 个被上游**静默钳制**（模型表给 64K，实际 16K 就断）。核心思想：
// **实测值不写死代码**——探测结果落盘，重跑即刷新；模型表只做参考下界。
//
// 判定（三态，与 panel 同口径）：
//   clamped     上游在到达请求的 max_tokens 前就 finish=length 且输出明显不足
//               ——该档位即「实际输出上限」（或它的量化邻域）
//   at_least    输出追平了请求的 max_tokens（finish=length 且 completion≈N）
//               ——真实上限 ≥ 该档，继续升阶；全部档位追平 → at_least 最高档
//   inconclusive 请求失败 / 无 usage / 结果模糊——如实记，不猜
//
// 请求走 probe:true（不惩罚账号——撞风控/限流不给账号写冷却，与 billing-check
// 同口径）。每档一个请求，最多 4 档；探针是显式运维动作，不是常驻轮询。
const STEPS = [4096, 16384, 32768, 65536];

/** 阶梯按模型表上限裁剪：maxTokens 65536 以上才有 65536 档 */
function stepsFor(modelMaxTokens) {
  const cap = Number(modelMaxTokens) > 0 ? Number(modelMaxTokens) : 65536;
  const steps = STEPS.filter((s) => s <= cap);
  if (!steps.length) steps.push(STEPS[0]);
  return steps;
}

/** 单档判定（纯函数，可离线测） */
function judgeStep(requested, completion, finish) {
  if (!Number.isFinite(completion) || completion <= 0) return 'inconclusive';
  if (finish === 'length') {
    // finish=length：追平（≥90%）→ at_least；明显不足 → clamped
    return completion >= requested * 0.9 ? 'at_least' : 'clamped';
  }
  if (finish === 'stop') {
    // 自然收尾（stop）= 模型自己说完了，与上限无关 → 该档只能说明「没撞顶」
    return 'below';
  }
  // 其它 finish（缺失/未知形态）：响应可疑，如实 inconclusive——不猜
  return 'inconclusive';
}

/**
 * 探一个模型。返回探测行：
 *   { model, region, verdict, atLeast, clamped, steps: [...], ts, elapsedMs, error? }
 */
async function probeOne(model, opts = {}) {
  const region = opts.region === 'intl' ? 'global' : (opts.region === 'global' ? 'global' : 'cn');
  const wb = require('./index');
  const modelsMod = require('./models');
  const startedAt = Date.now();

  // 模型表上限：裁阶梯用。取不到就按 65536 探（如实记 metaMissing）
  let modelMax = null;
  try {
    const r = await modelsMod.fetchModels({ region });
    const meta = (r.models || []).find((m) => m.id === model) || null;
    if (meta && meta.maxTokens) modelMax = Number(meta.maxTokens);
  } catch (e) { /* 表不可用照探 */ }

  const steps = stepsFor(modelMax);
  const stepRows = [];
  let verdict = 'inconclusive';
  let atLeast = null;
  let clamped = null;
  let error = '';

  for (const n of steps) {
    let completion = null;
    let finish = null;
    let err = '';
    try {
      const agg = await wb.send({
        model: `workbuddy/${model}`,
        messages: [{
          role: 'user',
          content: `请围绕「如何长期坚持写日记」这个主题写一篇尽可能长的说明文，要求：不要分点标题，用连贯段落；写满约 ${Math.round(n / 2)} 字再停。`,
        }],
        max_tokens: n,
      }, undefined, { region, probe: true });
      const u = (agg && agg.usage) || null;
      completion = u ? (u.completion_tokens || 0) : null;
      finish = (agg && agg.choices && agg.choices[0] && agg.choices[0].finish_reason) || null;
    } catch (e) {
      err = e.message || String(e);
    }
    const j = err ? 'inconclusive' : judgeStep(n, completion, finish);
    stepRows.push({ requested: n, completion, finish, verdict: j, error: err || undefined });
    if (j === 'clamped' && clamped == null) {
      clamped = completion;
      verdict = 'clamped';
      break; // 已撞顶：更高档只会得到同样的钳制，不必再烧
    }
    if (j === 'at_least') {
      atLeast = n;
      verdict = 'at_least';
      continue; // 追平了 → 升阶确认真实上限
    }
    if (j === 'below') {
      // 自然收尾：输出没顶到 max_tokens——说明真实上限 ≥ 本档但探索不出更多，
      // 记 at_least（诚实口径：没撞顶就是没撞顶）
      atLeast = Math.max(atLeast || 0, n);
      verdict = 'at_least';
    }
    // inconclusive：记行、继续下一档（单档失败可能是限流，换一档可能就成）
  }

  const row = {
    model,
    region,
    verdict,
    atLeast,
    clamped,
    modelMaxTokens: modelMax,
    steps: stepRows,
    ts: Date.now(),
    elapsedMs: Date.now() - startedAt,
  };
  if (error) row.error = error;
  return row;
}

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || require('path').resolve(__dirname, '..', '..', 'data');
}
function filePath() {
  return require('path').join(dataDir(), 'workbuddy-output-probes.json');
}

/** 读全量探测结果（按 model+region 键）。文件缺失/坏 → 空表 */
function loadProbes() {
  try {
    const doc = JSON.parse(require('fs').readFileSync(filePath(), 'utf8'));
    return doc && typeof doc === 'object' ? doc : {};
  } catch (e) {
    return {};
  }
}

/** 原子落盘探测行（键 model|region，一行一档覆盖旧值）。写失败不影响返回 */
function saveProbe(row) {
  try {
    const fs = require('fs');
    const path = require('path');
    const filelock = require('../filelock');
    const target = filePath();
    fs.mkdirSync(dataDir(), { recursive: true });
    const doc = loadProbes();
    doc[`${row.model}|${row.region}`] = row;
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    filelock.renameAtomic(tmp, target);
    return true;
  } catch (e) {
    return false;
  }
}

/** 探测结果是否过期（UI 褪色标注用）：30 天。panel 同款阈值 */
function isStale(row, now = Date.now()) {
  return !row || !row.ts || (now - row.ts > 30 * 86400 * 1000);
}

module.exports = { STEPS, stepsFor, judgeStep, probeOne, loadProbes, saveProbe, isStale, filePath };
