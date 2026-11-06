// probe-qianfan-caps.js - 千帆原生 /gateway/v2 模型的上限与倍率探针（一次性）
//
// 2026-11-06 实测结论（qwen3.5-35b-a3b，账号 usecanwe777 / 账号 1，六发探针）：
//   输入 tokens   max_tokens   结果
//   126,512       1            200 通过
//   506,012       1            400 "input token limit is 258048"
//   258,050       1            200 通过（超文案数字 2 个 token）
//   258,050       65,536       200 通过（max_tokens 不参与联合校验）
//   262,200       1            400（文案固定，超多少都报 258048）
//   100,000,000   -            400 "max_tokens range is [1, 65536]"（免费）
//   真实窗口 262,144（256K）；文案 258048 = 262,144−4,096 默认输出预留的
//   标称输入限额，不能按字面当硬边界。max_tokens 上限 65,536。
//   计费分价：input ≈0.5 / output ≈4.0 积分/千token
//     （两点定标：30in+700out=2.81；126512in+1out=63.26；联立自洽）
//   上游身份：400 错误链明示 qianfan.baidubce.com/v2/chat/completions
//   结论已写进 src/qianfan-raw.js 的 MODEL_META（model-info.qianfanRows 消费）。
//   教训两条：
//   1. ctx 探针的载荷系数必须以**回显闭环**为准——"a " 每单元恰好 1 token
//      （65287 单元 → 65299 = 65287+12 对话模板），纯 "a" 是 8 字符/token；
//      按「校准样本比值 1.012」构造会把输入打出一半，烧了积分只测到下界。
//   2. 上游 400 文案的数字是**标称值**不是校验边界——「略超边界预期 400」
//      的探针点可能 200 通过，边界要两点夹逼后再下结论。
//
// 与 src/qianfan-raw.js 同一凭证（webPool.getToken）与同一端点（/gateway/v2），
// 但不喂池（不 markSuccess/markFailure）——探针的成败不该惩罚账号。
//
// 用法：
//   node probe-qianfan-caps.js rate           计费倍率（余额前后差 + usage）
//   node probe-qianfan-caps.js caps [model]   max_tokens 上限（400 错误体明示）
//   node probe-qianfan-caps.js ctx <tokens> [model]
//                                             输入上下文探针（构造 N token 输入）
const https = require('https');
const webPool = require('./src/web-pool');
const accounts = require('./src/accounts');
const web = require('./src/dumate-web');

const HOST = webPool.GATEWAY_HOST;
const PATH = '/gateway/v2/chat/completions';

function rawJSON(token, body, timeout = 300000) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: HOST,
      path: PATH,
      method: 'POST',
      timeout,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Appbuilder-From': 'openclaw',
        'X-Dumate-Client-Type': 'web',
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

async function balanceOf(name) {
  try {
    const a = accounts.load().accounts.find((x) => x.name === name || x.nickname === name);
    if (!a || !a.cookie) return null;
    const agent = web.agentFor(a);
    const r = await web.api.quotaOverview(a.cookie, { agent });
    return r.ok ? r.left : null;
  } catch (e) {
    return null;
  }
}

(async () => {
  const mode = process.argv[2] || 'rate';
  const p = webPool.pick(new Set());
  if (!p) throw new Error('没有可用网页账号');
  const acc = p.account;
  const name = acc.name || acc.nickname || `账号${acc.id}`;
  const model = mode === 'ctx' ? (process.argv[4] || 'qwen3.5-35b-a3b') : (process.argv[3] || 'qwen3.5-35b-a3b');
  console.log(`账号: ${name}  模型: ${model}  host: ${HOST}`);

  const t = await webPool.getToken(acc);
  if (!t.ok) throw new Error(`token: ${t.error}`);

  if (mode === 'rate') {
    const b0 = await balanceOf(name);
    console.log('请求前余额:', b0);
    const r = await rawJSON(t.token, {
      model,
      messages: [{ role: 'user', content: '请从1数到400，用顿号分隔，不要输出其他内容' }],
      max_tokens: 700,
    });
    if (r.status !== 200) {
      console.log('HTTP', r.status, r.body.replace(/\s+/g, ' ').slice(0, 300));
      process.exitCode = 1;
      return;
    }
    const u = (JSON.parse(r.body).usage) || {};
    console.log('usage:', JSON.stringify(u));
    const b1 = await balanceOf(name);
    console.log('请求后余额:', b1);
    const toks = (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0);
    if (typeof b0 === 'number' && typeof b1 === 'number' && toks > 0) {
      const cost = Math.round((b0 - b1) * 100) / 100;
      console.log(`消耗: ${cost} 积分 / ${toks} tokens → ${(cost / toks * 1000).toFixed(4)} 积分/千token`);
    } else {
      console.log('差值不可得（余额读取失败或 usage 缺失）');
    }
    return;
  }

  if (mode === 'caps') {
    const r = await rawJSON(t.token, {
      model,
      messages: [{ role: 'user', content: '数到3' }],
      max_tokens: 100000000,
    });
    console.log('HTTP', r.status);
    console.log('body:', r.body.replace(/\s+/g, ' ').slice(0, 500));
    return;
  }

  if (mode === 'ctx') {
    const tokens = parseInt(process.argv[3] || '2000000', 10);
    // 可选第三参：max_tokens（默认 1）。联合窗口假设（input+max_tokens ≤
    // 262,144）用「同输入、大 max_tokens 必被拒」判别——参数校验层拒绝不计费
    const maxTok = parseInt(process.argv[5] || '1', 10);
    // 自校准："a "×1000 的真实 prompt_tokens 决定字符→token 系数
    const cal = await rawJSON(t.token, {
      model,
      messages: [{ role: 'user', content: 'a '.repeat(1000) }],
      max_tokens: 1,
    });
    let perChar = 0.5; // 兜底：假设 2 字符 ≈ 1 token
    if (cal.status === 200) {
      const cu = (JSON.parse(cal.body).usage) || {};
      if (cu.prompt_tokens) perChar = 2000 / cu.prompt_tokens;
      console.log(`校准: "a "×1000 → ${cu.prompt_tokens} prompt_tokens（${perChar.toFixed(4)} token/字符）`);
    } else {
      console.log(`校准请求 HTTP ${cal.status}，按 0.5 token/字符 兜底`);
    }
    // 载荷形状必须与校准样本一致，且系数以**回显闭环**为准：
    // "a " 每单元恰好 1 token（2026-11-06 回显证实：65287 单元 → 65299 =
    // 65287 + 12 对话模板），纯 "a" 是 8 字符/token——两者系数差 8 倍，
    // 第一二枪就是死在没做回显闭环上。
    const units = Math.max(1, tokens - 12);
    const content = 'a '.repeat(units);
    console.log(`构造输入: ${content.length} 字符 ≈ ${tokens} tokens，body ≈ ${(content.length / 1048576).toFixed(1)} MB`);
    const b0 = await balanceOf(name);
    const r = await rawJSON(t.token, {
      model,
      messages: [{ role: 'user', content }],
      max_tokens: maxTok,
    }, 600000);
    console.log('HTTP', r.status);
    console.log('body:', r.body.replace(/\s+/g, ' ').slice(0, 500));
    const b1 = await balanceOf(name);
    console.log('余额:', b0, '→', b1);
    return;
  }

  console.log('未知模式:', mode);
  process.exitCode = 1;
})();
