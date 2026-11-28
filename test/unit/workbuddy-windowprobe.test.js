// test/unit/workbuddy-windowprobe.test.js - 6004 模型额度窗口探针（批次十，misakano windowprobe.go 移植）
//
// 锁的行为：
//   1. registerWindow：只在重置墙钟合法（未来时刻）时登记；upsert 按
//      (账号,模型)，新墙钟无条件覆盖、计数归零
//   2. blockedReason 选号闸门：账号退场/停用 → 拦；区域不符 → 拦；正常 → ''
//   3. scanProbeStream：choices 帧 → opened；6004 error 帧带墙钟 → limited+resetAt；
//      无墙钟 → limited 但 resetAt null；HTTP 200 里的限流不能只看状态码
//   4. probeWindow 四分支（windowprobe.go probeWindow 口径）：
//      opened → 清 (账号,模型) 模型冷却 + 删记录；
//      更晚 resetAt → 换新墙钟计数归零；
//      同时刻限流 → 15s 重试并补记 attempts；
//      其它错误 → 删记录不重试
//   5. attempts 撞 MAX_ATTEMPTS → gave_up 删记录（循环不空转）
//   6. 闸门拦截的窗口不发探针、直接删（记录留着只会每轮被取出）
//   7. runDue：只处理到点窗口、BATCH_LIMIT 截断、闸门拦截不计入 sent
//
// 运行：node --test test/unit/workbuddy-windowprobe.test.js
// 注意：窗口表落 DUMATE_ADMIN_DATA（测试钉临时目录）；探针走 chat.postStream
// 真实代码路径，测试打桩该 seam——stub 恢复必须写在测试体内（文件加载时顶层
// 恢复会被后续用例的再打桩覆盖，批次八教训）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

process.env.DUMATE_ADMIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-winprobe-'));

const wp = require('../../src/workbuddy/windowprobe');
const c = require('../../src/workbuddy/constants');
const chat = require('../../src/workbuddy/chat');
const auth = require('../../src/workbuddy/auth');
const channelPool = require('../../src/channel-pool');

// ---- stub 基建（每个用例先恢复再打桩，断言失败也不会污染下一个用例）----
const realPostStream = chat.postStream;
const realFindUsable = auth.findUsable;
const realClearModelBlock = channelPool.clearModelBlock;
const restoreStubs = () => {
  chat.postStream = realPostStream;
  auth.findUsable = realFindUsable;
  channelPool.clearModelBlock = realClearModelBlock;
};
test.afterEach(() => restoreStubs());

const ACC = { id: 7, uid: 'u-winprobe', region: 'cn', accessToken: 'at', enabled: true };
const FUTURE = Date.now() + 3600_000; // 未来 1h

// registerWindow 只收未来时刻（设计如此——登记发生在 6004 报文到达时，重置点
// 必然在未来）。测试要造「到点窗口」：先登记未来再把落盘记录回拨 1s。
const STORE_FILE = () => path.join(process.env.DUMATE_ADMIN_DATA, 'workbuddy-model-windows.json');
function backdate(accountId, model) {
  const j = JSON.parse(fs.readFileSync(STORE_FILE(), 'utf8'));
  const w = j.windows.find((x) => x.accountId === accountId && x.model === model);
  w.resetAt = Date.now() - 1000;
  fs.writeFileSync(STORE_FILE(), JSON.stringify(j));
}
// 登记一条已到点的窗口（测试基建，非生产路径）
const registerDue = (accountId, model, opts) => {
  assert.equal(wp.registerWindow(accountId, model, Date.now() + 60_000, opts), true);
  backdate(accountId, model);
};

// 6004 信封：措辞避开 HARD_CREDIT_MARKERS 的 'quota exceeded'（classifyStatus
// 里 hard_credit 先判，措辞撞上会误分类——code 6004 是唯一判据）
const cap6004 = (wall) => JSON.stringify({ code: 6004, msg: `usage exceeds frequency limit, reset at ${wall}` });

const sse = (frames) => Readable.from(frames.map((f) => `data: ${f}\n\n`));
const rawSse = (text) => Readable.from([text]);

test('registerWindow：合法登记 + 字段形状；非法（过去/NaN/空模型/坏 id）拒绝', () => {
  assert.equal(wp.registerWindow(7, 'glm-5.3', FUTURE, { region: 'cn', detail: '6004' }), true);
  const w = wp.listWindows().find((x) => x.accountId === 7 && x.model === 'glm-5.3');
  assert.ok(w, '已落盘');
  assert.equal(w.region, 'cn');
  assert.equal(w.resetAt, FUTURE);
  assert.equal(w.attempts, 0);
  assert.equal(w.detail, '6004');
  assert.ok(w.registeredAt > 0);
  // 非法一律 false，不落盘
  assert.equal(wp.registerWindow(7, 'past', Date.now() - 1000), false, '过去时刻');
  assert.equal(wp.registerWindow(7, 'nan', Number.NaN), false);
  assert.equal(wp.registerWindow(7, '', FUTURE), false, '空模型');
  assert.equal(wp.registerWindow(Number.NaN, 'm', FUTURE), false, '坏账号 id');
  wp.dropWindow(7, 'glm-5.3');
  assert.ok(!wp.listWindows().some((x) => x.accountId === 7 && x.model === 'glm-5.3'));
});

test('upsert 同 (账号,模型) 覆盖：新墙钟赢、attempts 归零；不同模型共存', () => {
  wp.registerWindow(8, 'glm-5.3', FUTURE);
  wp.bumpAttempts(8, 'glm-5.3', 5);
  wp.registerWindow(8, 'glm-5.3', FUTURE + 60_000, { region: 'cn' });
  const w = wp.listWindows().find((x) => x.accountId === 8 && x.model === 'glm-5.3');
  assert.equal(w.resetAt, FUTURE + 60_000, '新墙钟无条件覆盖');
  assert.equal(w.attempts, 0, '覆盖即计数归零');
  wp.registerWindow(8, 'kimi-k3', FUTURE);
  assert.ok(wp.listWindows().some((x) => x.accountId === 8 && x.model === 'kimi-k3'), '不同模型是独立窗口');
  wp.dropWindow(8, 'glm-5.3');
  wp.dropWindow(8, 'kimi-k3');
});

test('dueWindows 只回到点的（按时刻排序）；nextDue 是最近的未来时刻', () => {
  wp.registerWindow(9, 'm1', Date.now() + 1000);
  wp.registerWindow(9, 'm2', Date.now() + 5000);
  wp.registerWindow(9, 'm3', Date.now() + 3000);
  assert.deepEqual(wp.dueWindows(Date.now() + 2000).map((w) => w.model), ['m1'], '未到点不回');
  assert.deepEqual(wp.dueWindows(Date.now() + 6000).map((w) => w.model), ['m1', 'm3', 'm2'], '升序');
  assert.equal(wp.nextDue(), Math.min(...wp.listWindows().filter((x) => x.accountId === 9).map((x) => x.resetAt)));
  wp.dropWindow(9, 'm1');
  wp.dropWindow(9, 'm2');
  wp.dropWindow(9, 'm3');
  assert.equal(wp.nextDue(), null);
});

test('blockedReason：退场/停用拦、区域不符拦、正常放行', () => {
  auth.findUsable = () => [];
  assert.equal(wp.blockedReason({ accountId: 999, region: 'cn' }), '账号已退场或停用');
  auth.findUsable = () => [{ ...ACC, id: 7, region: 'global' }];
  assert.equal(wp.blockedReason({ accountId: 7, region: 'cn' }), '账号区域与登记不符');
  auth.findUsable = () => [ACC];
  assert.equal(wp.blockedReason({ accountId: 7, region: 'cn' }), '');
});

test('scanProbeStream：choices 帧 → opened（HTTP 200 里的限流不能只看状态码）', async () => {
  const r1 = await wp.scanProbeStream(sse(['{"choices":[{"delta":{"content":"hi"}}]}', '[DONE]']));
  assert.equal(r1.opened, true);
  assert.equal(r1.limited, false);
  // 6004 error 帧带墙钟 → limited + resetAt
  const wall = '2026-11-29 12:00:00';
  const payload = cap6004(wall);
  const r2 = await wp.scanProbeStream(sse([payload]));
  assert.equal(r2.opened, false);
  assert.equal(r2.limited, true);
  assert.equal(r2.resetAt, c.parseRateLimitReset(payload) * 1000);
  // 6004 无墙钟 → limited 但 resetAt null（走重试分支不换墙钟）
  const r3 = await wp.scanProbeStream(sse([JSON.stringify({ code: 6004, msg: 'usage exceeds frequency limit' })]));
  assert.equal(r3.limited, true);
  assert.equal(r3.resetAt, null);
  // 非限流错误帧 → 全 false（走 failed 分支删记录）
  const r4 = await wp.scanProbeStream(sse([JSON.stringify({ error: { code: 11128, msg: 'channel check' } })]));
  assert.equal(r4.opened, false);
  assert.equal(r4.limited, false);
  // 空流
  const r5 = await wp.scanProbeStream(rawSse(''));
  assert.equal(r5.opened, false);
  assert.equal(r5.limited, false);
});

test('fireProbe：postStream 抛错 → probe error，不 opened 不 limited', async () => {
  chat.postStream = async () => { throw new Error('net down'); };
  const r = await wp.fireProbe('cn', ACC, 'glm-5.3');
  assert.equal(r.opened, false);
  assert.equal(r.limited, false);
  assert.ok(/probe error: net down/.test(r.detail));
});

test('probeWindow opened：清 (账号,模型) 模型冷却 + 删记录', async () => {
  registerDue(ACC.id, 'glm-5.3', { region: 'cn' });
  auth.findUsable = () => [ACC];
  const cleared = [];
  channelPool.clearModelBlock = (channel, id, model) => cleared.push([channel, id, model]);
  chat.postStream = async (region, account, payload, opts) => {
    assert.equal(opts.agentType, 'auxiliary', '探针请求必须是 auxiliary');
    assert.equal(payload.max_tokens, wp.PROBE_MAX_TOKENS);
    assert.deepEqual(payload.messages, [{ role: 'user', content: wp.PROBE_PROMPT }]);
    return { fatal: false, status: 200, stream: sse(['{"choices":[{"delta":{"content":"ok"}}]}']) };
  };
  const w = wp.listWindows()[0];
  const r = await wp.probeWindow(w);
  assert.equal(r.action, 'opened');
  assert.deepEqual(cleared, [['workbuddy', ACC.id, 'glm-5.3']], '只清这条额度线的冷却');
  assert.equal(wp.listWindows().length, 0, '记录已删');
});

test('probeWindow rescheduled：更晚 resetAt 换新墙钟、计数归零', async () => {
  const wall = '2026-11-29 12:00:00';
  const payload = cap6004(wall);
  registerDue(ACC.id, 'glm-5.3', { region: 'cn' });
  wp.bumpAttempts(ACC.id, 'glm-5.3', 3);
  auth.findUsable = () => [ACC];
  chat.postStream = async () => ({
    fatal: false, status: 429,
    stream: rawSse(JSON.stringify({ code: 6004, msg: `usage exceeds frequency limit, reset at ${wall}` })),
  });
  const r = await wp.probeWindow(wp.listWindows()[0]);
  assert.equal(r.action, 'rescheduled');
  const w = wp.listWindows().find((x) => x.accountId === ACC.id && x.model === 'glm-5.3');
  assert.equal(w.resetAt, c.parseRateLimitReset(payload) * 1000, '墙钟换成上游新给的');
  assert.equal(w.attempts, 0, '计数归零');
  wp.dropWindow(ACC.id, 'glm-5.3');
});

test('probeWindow retry：同时刻限流 → resetAt 推后 15s、attempts 补记', async () => {
  registerDue(ACC.id, 'glm-5.3', { region: 'cn' });
  auth.findUsable = () => [ACC];
  chat.postStream = async () => ({
    fatal: false, status: 429,
    stream: rawSse(JSON.stringify({ code: 6004, msg: 'usage exceeds frequency limit' })),
  });
  const before = Date.now();
  const r = await wp.probeWindow(wp.listWindows()[0]);
  assert.equal(r.action, 'retry');
  assert.equal(r.attempts, 1);
  const w = wp.listWindows().find((x) => x.accountId === ACC.id && x.model === 'glm-5.3');
  assert.ok(w, '记录还在');
  assert.equal(w.attempts, 1, 'registerWindow 归零后由 bumpAttempts 补回');
  assert.ok(w.resetAt >= before + wp.RETRY_DELAY_MS - 500 && w.resetAt <= Date.now() + wp.RETRY_DELAY_MS + 500);
  wp.dropWindow(ACC.id, 'glm-5.3');
});

test('probeWindow gave_up：attempts 撞 MAX_ATTEMPTS 删记录（循环不空转）', async () => {
  registerDue(ACC.id, 'glm-5.3', { region: 'cn' });
  wp.bumpAttempts(ACC.id, 'glm-5.3', wp.MAX_ATTEMPTS - 1);
  auth.findUsable = () => [ACC];
  let calls = 0;
  chat.postStream = async () => { calls++; return { fatal: false, status: 429, stream: rawSse('{"code":6004}') }; };
  const r = await wp.probeWindow(wp.listWindows()[0]);
  assert.equal(r.action, 'gave_up');
  assert.equal(calls, 1, '探针发过这一次');
  assert.equal(wp.listWindows().length, 0, '放弃即删，真实 429 会重新登记');
});

test('probeWindow failed：非限流错误不重试，删记录', async () => {
  registerDue(ACC.id, 'glm-5.3', { region: 'cn' });
  auth.findUsable = () => [ACC];
  chat.postStream = async () => ({ fatal: true, error: 'boom' });
  const r = await wp.probeWindow(wp.listWindows()[0]);
  assert.equal(r.action, 'failed');
  assert.ok(/boom/.test(r.detail));
  assert.equal(wp.listWindows().length, 0, '探针是真实计费请求，不值得反复打');
});

test('probeWindow 闸门：账号退场直接删记录，不发探针', async () => {
  registerDue(999, 'glm-5.3', { region: 'cn' });
  auth.findUsable = () => [];
  let calls = 0;
  chat.postStream = async () => { calls++; return { fatal: false, status: 200, stream: sse(['{"choices":[]}']) }; };
  const r = await wp.probeWindow(wp.listWindows()[0]);
  assert.equal(r.action, 'dropped');
  assert.ok(r.reason);
  assert.equal(calls, 0, '拦下的不发');
  assert.equal(wp.listWindows().length, 0, '记录留着只会每轮被取出');
});

test('runDue：只处理到点窗口、闸门拦截不计入 sent、BATCH_LIMIT 截断', async () => {
  // 三个到点 + 一个未来
  for (const m of ['a', 'b', 'c']) registerDue(ACC.id, m, { region: 'cn' });
  wp.registerWindow(ACC.id, 'future', Date.now() + 600_000, { region: 'cn' });
  auth.findUsable = () => [];
  const r1 = await wp.runDue();
  assert.equal(r1.sent, 0, '全被闸门拦下，不算发出');
  assert.deepEqual(r1.results.map((x) => x.model).sort(), ['a', 'b', 'c'], '未来窗口不处理');
  assert.ok(wp.listWindows().some((x) => x.model === 'future'), '未来窗口原样保留');
  // BATCH_LIMIT：登记 9 个到点窗口（全部闸门拦下 → 无 GAP 停留，快），只处理前 8 个
  for (let i = 0; i < wp.BATCH_LIMIT + 1; i++) registerDue(60, `m${i}`, { region: 'cn' });
  const r2 = await wp.runDue();
  assert.equal(r2.results.length, wp.BATCH_LIMIT, '一批最多 BATCH_LIMIT 个');
  assert.equal(wp.listWindows().filter((x) => x.accountId === 60).length, 1, '剩下的留给下一轮');
  wp.dropWindow(60, wp.listWindows().find((x) => x.accountId === 60).model);
});

test('enabled：默认开，DUMATE_WORKBUDDY_WINDOW_PROBE=0 关', () => {
  const prev = process.env.DUMATE_WORKBUDDY_WINDOW_PROBE;
  delete process.env.DUMATE_WORKBUDDY_WINDOW_PROBE;
  assert.equal(wp.enabled(), true);
  process.env.DUMATE_WORKBUDDY_WINDOW_PROBE = '0';
  assert.equal(wp.enabled(), false);
  if (prev === undefined) delete process.env.DUMATE_WORKBUDDY_WINDOW_PROBE;
  else process.env.DUMATE_WORKBUDDY_WINDOW_PROBE = prev;
});

test('接线自证：登记侧/执行侧/清冷却/头体同源/管理端五路都已接线', () => {
  const read = (p) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');
  const idxSrc = read('../../src/workbuddy/index.js');
  assert.ok(idxSrc.includes("require('./windowprobe').registerWindow"), 'index.js model_cap 分支调用登记');
  const srvSrc = read('../../src/server.js');
  assert.ok(srvSrc.includes("require('./workbuddy/windowprobe').startLoop"), 'server.js 启动探针循环');
  const poolSrc = read('../../src/channel-pool.js');
  assert.ok(/clearModelBlock[,}]/.test(poolSrc) && poolSrc.includes('pool.clearModelBlock(uidOf'), 'channel-pool 透传 clearModelBlock 并导出');
  const chatSrc = read('../../src/workbuddy/chat.js');
  assert.ok(chatSrc.includes('const convReqId = uuidv7hex();'), 'postStream 头体同源：一份 convReqId 进 body 与头');
  const routeSrc = read('../../src/admin/routes/workbuddy.js');
  assert.ok(routeSrc.includes("path: '/windows'"), '管理端窗口表端点');
  assert.ok(routeSrc.includes("path: '/windows/run'"), '管理端立即探针端点');
});
