// test/probe-dumate-rates.js - 双点解斜率测「每千 output token 积分成本」（P1-1 前置）
//
// 口径依据（社区 DuanZGit/dumate-duanz，2026-11-13，真实网关实测）：
//   对同一模型打两次不同长度的调用，用 completion_tokens 差解出**纯 output 斜率**，
//   固定开销（每次调用的固定扣费）自然抵消。这比本仓 dumate-billing.js 的
//   「单次小请求 + 余额前后差」准——后者把固定开销算进了斜率。
//
// 单位：**积分 / 千 output token**（不是本仓现有缓存的「积分/千token 综合」）。
// 两个口径不可混在同一列比大小，落地时要分字段。
//
// 成本：每个模型 2 次调用（短 max_tokens 24 + 长 max_tokens 800）。
//
// 用法：
//   node test/probe-dumate-rates.js                 # 只测 model-text（基准）
//   node test/probe-dumate-rates.js model-text glm-53
//   node test/probe-dumate-rates.js --all           # catalog 全量（44 次调用，谨慎）
const https = require('https');
const fs = require('fs');
const path = require('path');

const accounts = require('../src/accounts');
const web = require('../src/dumate-web');
const webPool = require('../src/web-pool');
const catalog = require('../src/dumate-catalog');

const GATEWAY = 'dumate-svc.baidu.com';
const CHAT_PATH = '/gateway/apis/v1/chat/completions';
const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
const OUT = path.join(DATA_DIR, 'probe-dumate-rates.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chat(token, model, prompt, maxTokens, agent = null) {
  const body = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, stream: false });
  return new Promise((resolve) => {
    const req = https.request({
      host: GATEWAY, path: CHAT_PATH, method: 'POST', timeout: 180000,
      // 账号配了出站代理就必须走它——对话与余额查询要同一个出口，
      // 否则探测绕过代理，既不真实也可能把宿主 IP 暴露给上游
      ...(agent ? { agent } : {}),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch (e) { /* html */ }
        resolve({ status: res.statusCode, json: j, head: b.slice(0, 200) });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, head: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, json: null, head: e.message }));
    req.write(body);
    req.end();
  });
}

async function usedPoints(cookie, agent = null) {
  const r = await web.api.quotaOverview(cookie, agent ? { agent } : {});
  if (!r.ok) throw new Error('quota_overview 失败：' + r.error);
  if (!Number.isFinite(Number(r.used))) throw new Error('quota_overview 没有 used 字段（余额未知 ≠ 0）');
  return Number(r.used);
}

const SHORT = '请只回复两个字：收到';
const LONG = '请从 1 数到 200，数字之间用逗号分隔，不要任何其他文字';

async function measure(cookie, token, model, agent = null) {
  // 429 退避：社区实测「限流是按账号的」，退避是唯一选择
  async function call(prompt, maxTokens) {
    for (let i = 0; i < 6; i++) {
      const r = await chat(token, model, prompt, maxTokens, agent);
      if (r.status === 429) { await sleep(15000 * (i + 1)); continue; }
      return r;
    }
    throw new Error('still rate limited');
  }

  const before = await usedPoints(cookie, agent);
  const a = await call(SHORT, 24);
  if (a.status !== 200 || !a.json || !a.json.usage) throw new Error(`短调用失败 HTTP ${a.status} ${a.head}`);
  await sleep(1500);
  const mid = await usedPoints(cookie, agent);
  const b = await call(LONG, 800);
  if (b.status !== 200 || !b.json || !b.json.usage) throw new Error(`长调用失败 HTTP ${b.status} ${b.head}`);
  await sleep(1500);
  const after = await usedPoints(cookie, agent);

  const dShort = mid - before;
  const dLong = after - mid;
  const ua = a.json.usage;
  const ub = b.json.usage;
  const dTokens = Number(ub.completion_tokens) - Number(ua.completion_tokens);
  if (!(dTokens > 50)) {
    return { model, error: `输出差太小（${dTokens}），解不出斜率`, dShort, dLong, tokens: `${ua.prompt_tokens}+${ua.completion_tokens} / ${ub.prompt_tokens}+${ub.completion_tokens}` };
  }
  const outPerK = ((dLong - dShort) / dTokens) * 1000;
  const inPerK = (dShort - Number(ua.completion_tokens) * (outPerK / 1000)) / Math.max(1, Number(ua.prompt_tokens)) * 1000;
  return {
    model,
    pointsPerKOut: Number(outPerK.toFixed(4)),
    pointsPerKIn: inPerK > 0 ? Number(inPerK.toFixed(4)) : null,
    charged: { short: dShort, long: dLong },
    tokens: `${ua.prompt_tokens}+${ua.completion_tokens} / ${ub.prompt_tokens}+${ub.completion_tokens}`,
  };
}

(async () => {
  const args = process.argv.slice(2).filter((a) => a !== '--append');
  const append = process.argv.includes('--append');
  let models;
  if (args[0] === '--all') models = catalog.ids();
  else if (args.length) models = args;
  else models = ['model-text'];

  const list = accounts.list() || [];
  if (!list.length) { console.error('账号池空——先在管理端加一个网页凭证账号'); process.exit(2); }
  // 用**原始账号记录**（getRaw）：toPublic 的 proxy 已脱敏，合成 {id,cookie}
  // 又丢掉 proxy 字段——两者都会让 getToken / agentFor 拿到假账号，绑定代理
  // 的账号于是绕过出口或取票失败（review #15）。
  const raw = accounts.getRaw(list[0].id);
  if (!raw || !raw.cookie) { console.error('拿不到账号原始记录（含 cookie）'); process.exit(2); }
  const cookie = raw.cookie;
  let agent = null;
  try { agent = web.agentFor(raw); } catch (e) {
    console.error('账号出站代理配置非法：' + e.message + '（不静默回退直连）');
    process.exit(3);
  }
  const t = await webPool.getToken(raw, true, agent);
  if (!t.ok) { console.error('取 token 失败：' + t.error); process.exit(3); }
  console.log(`账号 ${list[0].id} / ${list[0].name} | 待测 ${models.length} 个模型\n`);

  const rows = [];
  for (const m of models) {
    try {
      const r = await measure(cookie, t.token, m, agent);
      rows.push(r);
      process.stderr.write('.');
    } catch (e) {
      rows.push({ model: m, error: String(e.message).slice(0, 120) });
      process.stderr.write('x');
    }
    await sleep(2500);
  }
  process.stderr.write('\n\n');

  const basis = (rows.find((r) => r.model === 'model-text' && r.pointsPerKOut) || {}).pointsPerKOut;
  for (const r of rows) {
    if (r.error) { console.log(`${r.model.padEnd(26)} ERROR  ${r.error}`); continue; }
    const pct = basis ? `${((r.pointsPerKOut / basis) * 100).toFixed(1)}%`.padStart(7) : '      -';
    console.log(`${r.model.padEnd(26)} ${String(r.pointsPerKOut).padStart(8)} 积分/千out ${pct}  in=${r.pointsPerKIn ?? '?'}  (${r.tokens})`);
  }

  // --append：读入已有结果，按 model 覆盖/追加。补测单个模型时不抹掉全量结果。
  let finalRows = rows;
  if (append) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      const map = new Map((prev.rows || []).map((r) => [r.model, r]));
      for (const r of rows) map.set(r.model, r);
      finalRows = [...map.values()];
    } catch (e) { /* 没有旧结果就当第一次跑 */ }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    at: new Date().toISOString(),
    account: { id: list[0].id, name: list[0].name },
    unit: 'points per 1k OUTPUT tokens (two-point slope)',
    basis: basis ? 'model-text' : null,
    rows: finalRows,
  }, null, 2));
  console.log(`\n结果已落盘：${OUT}`);
})();
