// test/probe-workbuddy-tasks.js - 成长任务写路径前置探针（P0-6，不探不接）
//
// 批次三 P0-6 的写端点在接进来之前，先在**目标账号的实际主机 + 头族**下探一遍。
// 每个探针都用**无副作用形态**：
//   1. accept  空数组 {"task_codes":[]}——报名空集 = 无操作；另探无 /v2 前缀对照
//   2. claim   用「已领过」的任务码打 web 域路径——回业务态，不动任何状态；
//              另探 CLI 域 /v2/.../reward/claim 证伪（misakano：该路径不存在）
//   3. redeem  用**锁定档位**（status !== unlocked）——回 403 天数不足，不会真领；
//              若档位全解锁则跳过（真领留给正式轮）
//   4. makeup  用**未断签日期**（heatmap score>0）——回 400 date is not broken，
//              不消耗补签卡；字段名 target_date vs date 两说，探针定
//
// 真机纪律：不打印 token / cookie；错误体截断；单账号（默认 id=1）。
// 运行：node test/probe-workbuddy-tasks.js [accountId]
'use strict';
process.env.DUMATE_ADMIN_DATA = process.env.DUMATE_ADMIN_DATA || '/home/zhou/code/claude/demo/dumate2api/data';

const c = require('../src/workbuddy/constants');
const authStore = require('../src/workbuddy/auth');

let https;
function request(opts, body) {
  return new Promise((resolve) => {
    https = https || require('https');
    const req = https.request(opts, (res) => {
      let buf = '';
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      res.on('data', (x) => { buf += dec.write(x); });
      res.on('end', () => { buf += dec.end(); resolve({ status: res.statusCode, body: buf }); });
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

function clip(s, n = 160) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** growth 域头族（= growth.js getJson 的已验证形状；POST 只加 Content-Type/Length） */
function growthHeaders(region, account, bodyLen) {
  const spec = c.specOf(region);
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': region === 'global' ? 'en-US' : 'zh-CN',
    'X-CodeBuddy-Request': '1',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Product': 'SaaS',
    Origin: spec.billingBase,
    Referer: `${spec.billingBase}/`,
    'User-Agent': c.CLIENT_UA,
    Authorization: `Bearer ${account.accessToken}`,
  };
  if (account.uid) headers['X-User-Id'] = account.uid;
  if (account.domain) headers['X-Domain'] = account.domain;
  if (account.enterpriseId) headers['X-Enterprise-Id'] = account.enterpriseId;
  if (bodyLen) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(bodyLen);
  }
  return headers;
}

/** web 域领奖头族（misakano ClaimReward 实测形状：x-client-platform: web） */
function webClaimHeaders(region, account, bodyLen) {
  const headers = {
    Authorization: `Bearer ${account.accessToken}`,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: 'https://www.workbuddy.cn',
    Referer: 'https://www.workbuddy.cn/profile/growth-center',
    'x-client-platform': 'web',
    'User-Agent': c.CLIENT_UA,
  };
  if (account.uid) headers['X-User-Id'] = account.uid;
  if (account.enterpriseId) {
    headers['X-Enterprise-Id'] = account.enterpriseId;
    headers['X-Tenant-Id'] = account.enterpriseId;
  }
  if (account.domain) headers['X-Domain'] = account.domain;
  if (bodyLen) headers['Content-Length'] = String(bodyLen);
  return headers;
}

async function getJson(region, account, host, path) {
  const u = new URL(host + path);
  const r = await request({
    hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
    headers: growthHeaders(region, account, 0), timeout: 15000,
  });
  let doc = null; try { doc = JSON.parse(r.body); } catch (e) { /* 非 JSON */ }
  return { status: r.status, doc, raw: r.body };
}

async function postJson(region, account, host, path, bodyObj, headerFamily) {
  const payload = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj), 'utf8');
  const u = new URL(host + path);
  const headers = headerFamily === 'web'
    ? webClaimHeaders(region, account, payload ? payload.length : 0)
    : growthHeaders(region, account, payload ? payload.length : 0);
  if (!payload) delete headers['Content-Type'];
  const r = await request({
    hostname: u.hostname, path: u.pathname, method: 'POST',
    headers, timeout: 15000,
  }, payload);
  let doc = null; try { doc = JSON.parse(r.body); } catch (e) { /* 非 JSON */ }
  return { status: r.status, doc, raw: r.body };
}

function show(label, r) {
  const code = r.doc && r.doc.code !== undefined ? `code=${r.doc.code}` : 'no-code';
  const msg = r.doc && (r.doc.msg || r.doc.message) ? ` msg=${clip(r.doc.msg || r.doc.message, 80)}` : '';
  console.log(`  [${r.status}] ${code}${msg} ${clip(r.raw, 110) === (r.doc ? JSON.stringify(r.doc).slice(0, 110) : '') ? '' : ''}`);
  if (!r.doc && r.raw) console.log(`      raw: ${clip(r.raw, 140)}`);
}

async function main() {
  const id = parseInt(process.argv[2] || '1', 10);
  const raw = authStore.get(id);
  if (!raw) { console.log(`账号 ${id} 不存在`); return; }
  const fr = await authStore.ensureFresh(raw);
  const account = authStore.get(id) || raw;
  if (fr && fr.ok === false) console.log(`⚠ ensureFresh 失败（继续用现有 token 试）：${fr.error || ''}`);
  const region = c.normalizeRegion(account.region) === 'global' ? 'global' : 'cn';
  const spec = c.specOf(region);
  const chatBase = spec.chatBase;
  // web 域：misakano 实测领奖必须走 www.workbuddy.cn（global 与 chat 域同主机）
  const webBase = region === 'global' ? spec.chatBase : 'https://www.workbuddy.cn';
  console.log(`账号 id=${id} region=${region} chatBase=${chatBase} webBase=${webBase}\n`);

  // ---- 0. 任务列表（已验证端点，顺带取探针素材）----
  const list = await getJson(region, account, chatBase, '/v2/activity/growth/tasks');
  console.log(`== 任务列表 GET ${chatBase}/v2/activity/growth/tasks`);
  show('list', list);
  const tasks = (list.doc && list.doc.data && Array.isArray(list.doc.data.tasks)) ? list.doc.data.tasks : [];
  const byStatus = {};
  for (const t of tasks) {
    const st = String(t.accept_status || 'unknown');
    byStatus[st] = (byStatus[st] || 0) + 1;
  }
  console.log(`  任务 ${tasks.length} 项，accept_status 分布: ${JSON.stringify(byStatus)}`);
  const claimedOne = tasks.find((t) => t.accept_status === 'claimed');
  const unaccepted = tasks.filter((t) => !t.locked && t.accept_status && t.accept_status !== 'claimed' && t.accept_status !== 'auto').slice(0, 5);
  console.log(`  已领样例: ${claimedOne ? claimedOne.task_code : '（无）'}；未接取样例: ${unaccepted.map((t) => `${t.task_code}(${t.accept_status})`).join(', ') || '（无）'}`);

  // ---- 1. streak（tier 权威来源 + redeem 探针素材）----
  const streak = await getJson(region, account, chatBase, '/activity/growth/streak');
  console.log(`\n== 连登 GET ${chatBase}/activity/growth/streak`);
  show('streak', streak);
  const sd = (streak.doc && streak.doc.data) || {};
  const red = sd.redemption_status || {};
  const tiers = Array.isArray(red.tiers) ? red.tiers : [];
  console.log(`  streak.days=${sd.streak && sd.streak.days} makeup_cards=${JSON.stringify(sd.makeup_cards || {})} makeup_dates=${JSON.stringify(sd.streak && sd.streak.makeup_dates || [])}`);
  for (const t of tiers) console.log(`  tier=${t.tier} days=${t.days} status=${red[`tier_${t.tier}_status`] || '?'} credit=${t.credit} cards=${t.cards}`);
  const lockedTier = tiers.find((t) => red[`tier_${t.tier}_status`] !== 'unlocked');

  // ---- 2. accept 探针（空数组 = 无操作；双前缀对照）----
  console.log(`\n== accept 探针 POST ${chatBase}/v2/activity/growth/tasks/accept  body={"task_codes":[]}`);
  show('accept /v2', await postJson(region, account, chatBase, '/v2/activity/growth/tasks/accept', { task_codes: [] }));
  console.log(`== accept 对照（无 /v2）POST ${chatBase}/activity/growth/tasks/accept`);
  show('accept no-prefix', await postJson(region, account, chatBase, '/activity/growth/tasks/accept', { task_codes: [] }));

  // ---- 3. claim 探针（已领任务码 = 业务态；CLI 域证伪）----
  if (claimedOne) {
    const code = String(claimedOne.task_code || claimedOne.code || '');
    console.log(`\n== claim 探针 POST ${webBase}/activity/growth/tasks/${code}/claim  (web 头族, 已领码)`);
    show('claim web', await postJson(region, account, webBase, `/activity/growth/tasks/${encodeURIComponent(code)}/claim`, undefined, 'web'));
    console.log(`== claim 证伪 POST ${chatBase}/v2/activity/growth/tasks/reward/claim  body={"task_code":"${code}"}`);
    show('claim cli-domain', await postJson(region, account, chatBase, '/v2/activity/growth/tasks/reward/claim', { task_code: code }));
  } else {
    console.log('\n== claim 探针跳过：列表里没有已领任务码（找不到安全的无副作用样例）');
  }

  // ---- 4. redeem 探针（锁定档位 = 403 业务态，不会真领）----
  if (lockedTier) {
    const tier = String(lockedTier.tier);
    console.log(`\n== redeem 探针 POST ${chatBase}/activity/growth/redeem  body={"tier":"${tier}","client_token":"u-<uuid4>"}（锁定档位）`);
    show('redeem locked', await postJson(region, account, chatBase, '/activity/growth/redeem',
      { tier, client_token: `u-${crypto_.randomUUID()}` }));
  } else {
    console.log('\n== redeem 探针跳过：没有锁定档位可安全探测（全解锁时真领留给正式轮）');
  }

  // ---- 5. makeup 探针（未断签日期 = 400 date is not broken，不耗卡）----
  const heat = await getJson(region, account, chatBase, '/activity/growth/heatmap');
  const cells = (heat.doc && heat.doc.data && Array.isArray(heat.doc.data.cells)) ? heat.doc.data.cells : [];
  const today = (heat.doc && heat.doc.data && heat.doc.data.today && heat.doc.data.today.date) || '';
  const monthStart = today.slice(0, 8) + '01';
  const litDay = cells.map((x) => String(x.date || '').slice(0, 10))
    .filter((d) => d.length === 10 && d >= monthStart && d < today && Number(cells.find((x) => String(x.date).startsWith(d))?.score) > 0)
    .sort().pop();
  if (litDay) {
    console.log(`\n== makeup 探针 POST ${chatBase}/activity/growth/makeup-cards/use  body={"target_date":"${litDay}"}（未断签日）`);
    show('makeup target_date', await postJson(region, account, chatBase, '/activity/growth/makeup-cards/use', { target_date: litDay }));
    console.log(`== makeup 对照 body={"date":"${litDay}"}（另一说字段名）`);
    show('makeup date', await postJson(region, account, chatBase, '/activity/growth/makeup-cards/use', { date: litDay }));
  } else {
    console.log('\n== makeup 探针跳过：本月没有 score>0 的日期（找不到安全的未断签样例）');
  }

  console.log('\n探针结束。结论落档：docs/CHANNEL-WORKBUDDY.md 11.x');
}

// crypto 引用延后（保持脚本顶部纯净）
const crypto_ = require('crypto');
main().catch((e) => { console.error('探针异常:', e.message); process.exit(1); });
