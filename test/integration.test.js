// test/integration.test.js - 集成阶段验收（node:test，全离线）
//
// A-E 六包「建而未接」的成果经 src/boot.js / src/channel-pool.js 缝进运行链路。
// 本文件验证的是**接缝本身**：
//   1. 启动链冒烟——模块按真实顺序初始化，互相不踩（boot.init / shutdown）；
//   2. 选号端到端——直连通道选号经池状态机（冷却/熔断跳选、粘性、在途帽、
//      uid 键位与 web 裸 id 不撞号），再用假上游打通 qwenwork.send 全链路；
//   3. 代理挂接——web-pool 出站请求真的走 getAgentFor（本地假 CONNECT 代理
//      见到 CONNECT 记录即为铁证，不出外网）；
//   4. 面板端点——C 包 snapshot/timeline/curve/rate 的 admin 只读端点
//      与 B 包 keepalive 管理面可用。
//
// 纪律：不起真服务（127.0.0.1 一次性 fixture 除外）、不连真实上游、
// 不碰 data/ 实值——全部数据落在 os.tmpdir 的一次性目录里。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// env 必须先于任何 src 模块加载（多数模块在 require 时固化数据目录）
const { tmpDir } = require('./helpers/tmpdir');
const TMP = tmpDir('dumate-integration');
process.env.DUMATE_ADMIN_DATA = TMP;
process.env.DUMATE_POOL_STATE = path.join(TMP, 'pool-state.json');
delete process.env.DUMATE_PROXY;          // 宿主 env 里若配了代理不得影响用例
delete process.env.DUMATE_USAGE_AGG;      // 显式确保计量挂钩默认开启

const boot = require('../src/boot');
const { pool } = require('../src/pool');
const channelPool = require('../src/channel-pool');
const balanceHist = require('../src/balance-hist');
const usageAgg = require('../src/usage-agg');

// 捕获 sendJSON 输出的假 res（router.sendJSON 只用 writeHead/end）
function fakeRes() {
  return {
    headersSent: false,
    writableEnded: false,
    statusCode: null,
    body: null,
    writeHead(code) { this.statusCode = code; this.headersSent = true; },
    end(buf) { this.body = buf; this.writableEnded = true; },
  };
}
function jsonOf(res) { return JSON.parse(res.body); }

test('启动链：模块按真实顺序初始化，互相不踩', () => {
  const logs = [];
  const st = boot.init({ log: (m) => logs.push(m) });

  // 顺序即依赖序：热配置 → 池 → 代理 → 计量 → 保活（保活只探测不排程，
  // 它由管理端进程经 task-scheduler 持有，见 boot.js 文件头）
  assert.deepStrictEqual(st.order, ['livecfg', 'pool', 'proxy', 'reqlog-hook', 'keepalive']);
  assert.ok(st.pool, '池恢复统计存在');
  assert.strictEqual(st.proxy, null, '无 DUMATE_PROXY 时全局代理为直连');
  assert.strictEqual(st.metering, 'on', 'C 包计量挂钩默认启用（懒加载接缝已确认）');
  assert.strictEqual(st.keepalive.mode, 'pool', 'B 包的 pool 接口假设已校准切真（非 stub）');

  // 每个被接线的模块都拿到可用实例
  assert.strictEqual(typeof pool.pick, 'function');
  assert.strictEqual(require('../src/livecfg').Load().recordClientInfo, true);
  assert.strictEqual(require('../src/proxy-agent').getGlobalProxy(), '');
  assert.strictEqual(typeof require('../src/reqlog-hook').feed, 'function');

  // 幂等：重复 init / shutdown 不抛、不重复起 flusher 之外的副作用
  const st2 = boot.init({ log: (m) => logs.push(m) });
  assert.deepStrictEqual(st2.order, st.order);
  boot.shutdown('test');
  boot.shutdown('test');
  assert.ok(logs.length > 0, '启动日志有产出');
});

test('选号经状态机：冷却/熔断跳选、粘性、模型负缓存、uid 键位不撞号', () => {
  channelPool._stickyClear();
  const accounts = [{ id: 1 }, { id: 2 }, { id: 3 }];

  // 无惩罚记录 = 健康：选得出且占用在途名额
  const s1 = channelPool.pickCandidate('qwenwork', accounts, { sessionKey: 'sess-a' });
  assert.ok(s1, '有健康账号可选');
  assert.ok(s1.uid.startsWith('qwenwork:'), '直连通道 uid = channel:id');
  // 粘性：同会话再选拿到同一账号
  const s2 = channelPool.pickCandidate('qwenwork', accounts, { sessionKey: 'sess-a' });
  assert.strictEqual(s2.uid, s1.uid, '会话粘性命中');
  channelPool.release(s1.uid);
  channelPool.release(s2.uid);

  // 429 → 软冷却：同会话粘性解绑换号
  channelPool.noteError('qwenwork', 1, { status: 429, message: 'rate limited', model: 'pro' });
  const s3 = channelPool.pickCandidate('qwenwork', accounts, { sessionKey: 'sess-a' });
  assert.notStrictEqual(s3.uid, 'qwenwork:1', '冷却账号被跳过且粘性解绑');
  channelPool.release(s3.uid);
  const st1 = pool.status('qwenwork:1');
  assert.strictEqual(st1.state, 'cooling');
  assert.strictEqual(st1.cool_kind, 'soft');

  // 5xx 连续 3 次 → 熔断
  for (let i = 0; i < 3; i++) channelPool.noteError('qwenwork', 2, { status: 500, message: 'boom', model: 'pro' });
  const s4 = channelPool.pickCandidate('qwenwork', accounts, { sessionKey: 'sess-b' });
  assert.strictEqual(s4.uid, 'qwenwork:3', '只剩账号 3 健康');
  channelPool.release(s4.uid);
  assert.strictEqual(pool.status('qwenwork:2').cool_kind, 'breaker');

  // 模型级负缓存：账号 3 对 pro 冷却后，带 model 的选号为 null，不带仍可选
  // （模型负缓存不算账号级 cooling——cool_kind 只反映冷却/熔断域）
  channelPool.noteError('qwenwork', 3, { status: 403, message: 'Model is not available for this user', model: 'pro' });
  assert.ok(pool.status('qwenwork:3').model_cooldowns.some((m) => m.model === 'pro'), '模型负缓存已记');
  assert.strictEqual(channelPool.pickCandidate('qwenwork', accounts, { model: 'pro' }), null);
  const s5 = channelPool.pickCandidate('qwenwork', accounts, {});
  assert.strictEqual(s5.uid, 'qwenwork:3', '不带模型约束时负缓存不拦');
  channelPool.release(s5.uid);

  // 成功喂池：清熔断观测（模型负缓存按设计保留）
  channelPool.noteSuccess('qwenwork', 3);
  const st3 = pool.status('qwenwork:3');
  assert.strictEqual(st3.breaker_fails, 0);
  assert.ok(st3.model_cooldowns.some((m) => m.model === 'pro'), '其他模型的成功不抹本模型负缓存');

  // uid 键位：web 裸 id 与 channel:id 是两条独立记录，互不污染
  channelPool.noteError('qwenwork', 1, { status: 429, message: 'x' });
  assert.strictEqual(pool.status('1').state, 'healthy', '裸 "1" 不是 qwenwork:1 的记录');
  assert.strictEqual(pool.status('qwenwork:1').state, 'cooling');

  // 落盘：池状态写到 DUMATE_POOL_STATE（重启恢复的载体）
  pool.flush();
  assert.ok(fs.existsSync(process.env.DUMATE_POOL_STATE), 'pool-state.json 落盘');
  const doc = JSON.parse(fs.readFileSync(process.env.DUMATE_POOL_STATE, 'utf8'));
  assert.ok(doc.accounts['qwenwork:1'], '落盘键位 = channel:id');
});

test('代理工厂：getAgentFor 按账号 proxy 字段 > 全局，无代理 null 直连', () => {
  const proxyAgent = require('../src/proxy-agent');
  assert.strictEqual(proxyAgent.getAgentFor({ id: 1 }), null, '无字段无全局 → 直连');
  const ag = proxyAgent.getAgentFor({ id: 1, proxy: 'http://127.0.0.1:3128' });
  assert.ok(ag, '账号字段生效');
  assert.strictEqual(proxyAgent.getAgentFor({ id: 2 }), null, '账号无字段仍直连（字段优先于全局）');
  proxyAgent.setGlobalProxy('http://127.0.0.1:3129');
  assert.ok(proxyAgent.getAgentFor({ id: 2 }), '全局默认生效');
  assert.throws(() => proxyAgent.getAgentFor({ id: 3, proxy: 'http://bad host' }), '非法配置抛错不回退直连');
  proxyAgent.setGlobalProxy('');
  proxyAgent.clearAgentCache();
});

test('代理挂接端到端：web-pool 出站请求经 getAgentFor（假 CONNECT 代理见到 CONNECT）', async () => {
  const http = require('http');
  const net = require('net');
  const webPool = require('../src/web-pool');

  // 本地假 CONNECT 代理：见到 CONNECT 记录后拒绝——请求不出本机、
  // 也绝不触达真实上游；「connects 里有记录」即证明走了 agent。
  const state = { connects: [] };
  const tunnels = new Set();
  const server = http.createServer((req, res) => { res.writeHead(500); res.end('not a connect'); });
  server.on('connect', (req, socket) => {
    tunnels.add(socket);
    state.connects.push(String(req.url));
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

  try {
    const account = { id: 9001, cookie: 'BDUSS=fake', proxy: `http://127.0.0.1:${port}` };
    const r = await webPool.callModel(account, '/chat/completions', 'POST',
      { model: 'model-text', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
    assert.strictEqual(r.ok, false, '代理拒绝 → 请求失败');
    assert.ok(state.connects.length >= 1, `CONNECT 经 agent 到达代理（看到：${state.connects.join(',')}）`);
    assert.ok(state.connects[0].endsWith(':443'), '隧道目标是对话网关的 443');

    // 无代理账号在同等条件下不会带 agent——出站语义保持直连
    assert.strictEqual(webPool.pick && require('../src/proxy-agent').getAgentFor({ id: 9002, cookie: 'BDUSS=x' }), null);
  } finally {
    for (const s of tunnels) s.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    require('../src/proxy-agent').clearAgentCache();
  }
});

test('keepalive 余额阶段喂 balance-hist（C 包观测挂钩的 B 侧接线）', async () => {
  const { internals } = require('../src/keepalive');
  const token = { aborted: false, on() {}, off() {}, abort() {} };
  const rows = await internals.balancePhase(
    [{ ad: { channel: 'web', balance: async () => ({ ok: true, remain: 123.45 }) }, uid: '77', name: '甲' }],
    { sem_cap: 1, per_account_delay_ms: 0 },
    token,
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].remain, 123.45);
  // 观测落账：首见建基线（delta=null），timeline 可查
  const tl = balanceHist.timeline({ account: '77', source: 'keepalive' });
  assert.ok(tl.rows.length >= 1, 'keepalive 查到的余额进入流水');
  assert.strictEqual(tl.rows[0].balance, 123.45);
  assert.strictEqual(tl.rows[0].channel, 'web');
});

test('离线等价：冷却账号签到解冻闭环（A 冻结 → B 余额回正 → 自动解冻）', async () => {
  // A 包标注的未执行项「真机冷却账号签到解冻需 B 接线后验证」的离线等价：
  // 真机留给用户，这里用真池单例 + B 的 normalizePool 对接层全链路模拟。
  const { internals } = require('../src/keepalive');

  // B 的接口假设校准终检：normalizePool 探测 A 包真单例 → mode 'pool'
  const np = internals.normalizePool(pool);
  assert.strictEqual(np.mode, 'pool', 'B 对 A 的接口假设已全部命中真名');
  assert.ok(Array.isArray(np.entries()), 'entries() 走 A 的 snapshot()');

  // 冻结（管理端 freeze 的池动作，kind=hard）；web 键位 = 裸 String(id)
  assert.strictEqual(pool.freeze('999', 60_000, '人工冻结'), true);
  assert.strictEqual(pool.status('999').cool_kind, 'hard');

  // 余额阶段查到余额（web adapter 的 uid 就是裸 id，与冻结键位一致才能闭环）
  const token = { aborted: false, on() {}, off() {}, abort() {} };
  const rows = await internals.balancePhase(
    [{ ad: { channel: 'web', balance: async () => ({ ok: true, remain: 50 }) }, uid: '999', name: '九' }],
    { sem_cap: 1, per_account_delay_ms: 0 },
    token,
  );

  // 解冻闭环：余额>0 且在硬冷却 → reenableIfCredits 解冻；解冻后恢复健康
  const rec = internals.reconcile(np, rows, { balance_threshold: 0 });
  assert.strictEqual(rec.unfrozen.length, 1, '闭环命中：解冻一条');
  assert.strictEqual(rec.unfrozen[0].uid, '999');
  assert.strictEqual(pool.status('999').state, 'healthy', '解冻后恢复健康');

  // 边界：余额查不到（null）的冷却账号不动——不猜 0 也不猜有
  pool.freeze('998', 60_000, 'again');
  const rows2 = await internals.balancePhase(
    [{ ad: { channel: 'web', balance: async () => ({ ok: false, remain: null, error: 'x' }) }, uid: '998', name: '八' }],
    { sem_cap: 1, per_account_delay_ms: 0 },
    token,
  );
  const rec2 = internals.reconcile(np, rows2, { balance_threshold: 0 });
  assert.strictEqual(rec2.unfrozen.length, 0, '查不到余额不解冻');
  assert.strictEqual(pool.status('998').state, 'cooling', '仍处冷却');

  pool.revive('999');
  pool.revive('998');
});

test('面板端点：usage /agg 与 points 余额时间线/曲线/速率只读可用', () => {
  // 造两条分桶数据 + 一条余额流水
  usageAgg.addEntry({ ts: Date.now(), channel: 'qwenwork', account: '1', model: 'pro', status: 200, input_tokens: 10, output_tokens: 5, ms: 100 });
  balanceHist.observe({ account: '77', channel: 'web', balance: 200, source: 'test' });

  const { routes: usageRoutes } = require('../src/admin/routes/usage');
  const aggRoute = usageRoutes.find((r) => r.path === '/agg');
  assert.ok(aggRoute, '/agg 路由已挂');
  const r1 = fakeRes();
  aggRoute.handler({ res: r1, req: { url: '/agg?hours=24&channel=qwenwork' }, params: [], body: null, user: { username: 'admin' } });
  const agg = jsonOf(r1);
  assert.strictEqual(r1.statusCode, 200);
  assert.strictEqual(agg.ok, true);
  assert.ok(agg.totals.requests >= 1, '分桶快照含刚喂的请求');
  assert.ok(agg.by_channel.some((x) => x.key === 'qwenwork' && x.requests >= 1), '按通道聚合可用');

  const { routes: pointsRoutes } = require('../src/admin/routes/points');
  const tlRoute = pointsRoutes.find((r) => r.path === '/balance-timeline');
  const cvRoute = pointsRoutes.find((r) => r.path === '/balance-curve');
  const rtRoute = pointsRoutes.find((r) => r.path === '/balance-rate');
  assert.ok(tlRoute && cvRoute && rtRoute, '三个余额视图路由已挂');

  const r2 = fakeRes();
  tlRoute.handler({ res: r2, req: { url: '/balance-timeline?account=77' }, params: [], body: null, user: { username: 'admin' } });
  const tl = jsonOf(r2);
  assert.strictEqual(tl.ok, true);
  assert.ok(tl.rows.some((x) => x.account === '77' && x.source === 'test'), '时间线含测试流水');

  const r3 = fakeRes();
  cvRoute.handler({ res: r3, req: { url: '/balance-curve?account=77' }, params: [], body: null, user: { username: 'admin' } });
  const cv = jsonOf(r3);
  assert.strictEqual(cv.ok, true);
  assert.ok(cv.points.length >= 2, '曲线点 = 基线 + 本次观测');

  const r4 = fakeRes();
  rtRoute.handler({ res: r4, req: { url: '/balance-rate?account=77&hours=24' }, params: [], body: null, user: { username: 'admin' } });
  const rt = jsonOf(r4);
  assert.strictEqual(rt.ok, true);
  assert.strictEqual(rt.account, '77');
  assert.ok(Number.isFinite(rt.consumed_per_hour), '速率窗口可折算');
});

test('面板端点：keepalive 管理面（GET 快照 / PUT 配置重排）', () => {
  const { routes } = require('../src/admin/routes/autotask');
  const getRoute = routes.find((r) => r.path === '/keepalive' && r.method === 'GET');
  const putRoute = routes.find((r) => r.path === '/keepalive' && r.method === 'POST');
  assert.ok(getRoute && putRoute, 'keepalive GET/POST 路由已挂');

  const r1 = fakeRes();
  getRoute.handler({ res: r1, req: { url: '/keepalive' }, params: [], body: null, user: { username: 'admin' } });
  const snap = jsonOf(r1);
  assert.strictEqual(r1.statusCode, 200);
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.pool_mode, 'pool', '保活对池的对接已切真');
  assert.strictEqual(snap.enabled, false, '新排程默认不自启（显式打开的纪律）');

  const r2 = fakeRes();
  putRoute.handler({ res: r2, req: { url: '/keepalive' }, params: [], body: { enabled: false, hour: 3, minute: 30 }, user: { username: 'admin' } });
  const cfg = jsonOf(r2);
  assert.strictEqual(r2.statusCode, 200);
  assert.strictEqual(cfg.hour, 3, '配置生效');
  assert.strictEqual(cfg.next_run_at, null, '未启用时无排程时刻');

  const r3 = fakeRes();
  putRoute.handler({ res: r3, req: { url: '/keepalive' }, params: [], body: { hour: 99 }, user: { username: 'admin' } });
  assert.strictEqual(r3.statusCode, 400, '越界配置 400');
});

test('qwenwork.send 端到端（假上游）：失败账号进冷却、故障转移换号成功', async () => {
  // stub 通道的三个网络/重依赖模块，再加载通道入口——send 全链路
  // （选号 → runOnce → 失败喂池 → 转移 → 成功喂池）走的是真代码。
  const calls = [];
  let failedOnce = false;
  const fakeChat = {
    calls,
    ensureAccount: async (store, account) => ({ id: account.id, uid: `uid-${account.id}`, accessToken: `tok-${account.id}`, machineId: `mid-${account.id}` }),
    resolveModelKey: (m) => String(m || 'pro'),
    buildBody: (k) => JSON.stringify({ model: k }),
    post: async (url, body, headers) => {
      const uid = headers && headers['x-fake-uid'];
      calls.push(uid);
      if (!failedOnce) { failedOnce = true; return { status: 200, headers: {}, raw: JSON.stringify({ code: 429, message: 'rate limited' }) }; }
      return { status: 200, headers: {}, raw: JSON.stringify({ code: 0, message: 'ok' }) };
    },
    postStream: async () => { throw new Error('本用例不走流式'); },
    payloadError: (o) => (o && Number(o.code) >= 400 ? { code: Number(o.code), message: String(o.message || '') } : null),
    envelopeStatus: (raw) => {
      try {
        const j = JSON.parse(String(raw));
        return Number(j.code) >= 400 ? { code: Number(j.code), message: String(j.message || '') } : null;
      } catch (e) { return null; }
    },
    unwrap: () => [],
    // index.js 的修复接线（repairable = chat.hasFunctionTools(payload) > 0 && …）会真调它——
    // 桩缺了这个方法整条用例报 TypeError（干净 HEAD 上复现过的预存失败）。
    // 返回 0 = 无工具调用 → repairable=false，保持本用例原意（失败→冷却→换号）。
    hasFunctionTools: () => 0,
    aggregate: (payloads, model) => ({ object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }], usage: {} }),
  };
  const fakeBridge = {
    warmup: () => {},
    signer: () => 'local',
    useWasm: () => false,
    helperPath: () => '',
    prepareInferAsync: async (o) => ({ url: 'https://chat.invalid/infer', body: o.bodyJson, headers: { 'x-fake-uid': o.uid } }),
  };
  const fakeCredits = { capture: async () => ({ ok: true }) };
  for (const [mod, exp] of [
    ['../src/qwenwork/chat.js', fakeChat],
    ['../src/qwenwork/bridge.js', fakeBridge],
    ['../src/qwenwork/credits.js', fakeCredits],
  ]) {
    const p = require.resolve(mod);
    require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
  }

  // 通道账号落在本用例的临时 data 目录（findUsable 判据：enabled+双 token）
  const qwAuth = require('../src/qwenwork/auth');
  const accounts = [
    { id: 21, name: '甲', enabled: true, accessToken: 'tok-21', refreshToken: 'rt-21', nickname: '甲' },
    { id: 22, name: '乙', enabled: true, accessToken: 'tok-22', refreshToken: 'rt-22', nickname: '乙' },
  ];
  // 直接写存储文件，绕开 save 的锁（单进程测试无并发）
  fs.writeFileSync(qwAuth.filePath(), JSON.stringify({ accounts }), 'utf8');

  const qw = require('../src/qwenwork');
  assert.strictEqual(qw.status().ready, true, '假上游下通道就绪');

  const payload = { model: 'qwen/pro', messages: [{ role: 'user', content: '你好' }] };
  const result = await qw.chatCompletion(payload, { reqId: 'test-req-1' });
  assert.ok(result && result.choices, '非流式拿到聚合结果');

  // 两次调用、两个不同账号：第一个失败进软冷却，转移后第二个成功
  // （fake 的 x-fake-uid 是 COSY uid 'uid-<id>'，映射回池键位 qwenwork:<id>）
  const poolUidOf = (u) => `qwenwork:${Number(String(u).slice(4))}`;
  assert.strictEqual(calls.length, 2, `实际调用序列：${calls.join(' → ')}`);
  assert.notStrictEqual(calls[0], calls[1], '故障转移换了账号');
  const failedRaw = calls[0];
  const okRaw = calls[1];
  const failedUid = poolUidOf(failedRaw);
  const okUid = poolUidOf(okRaw);
  assert.strictEqual(pool.status(failedUid).state, 'cooling', '失败账号进入冷却（429 → soft）');
  assert.strictEqual(pool.status(failedUid).cool_kind, 'soft');
  assert.ok(pool.status(okUid).ok_count >= 1, '成功账号 ok_count 喂池');

  // 再发一次同会话请求：失败账号仍在冷却、粘性落在成功账号上
  const before = calls.length;
  const result2 = await qw.chatCompletion(payload, { reqId: 'test-req-2' });
  assert.ok(result2 && result2.choices);
  assert.strictEqual(calls.length, before + 1, '不再重试失败账号');
  assert.strictEqual(calls[calls.length - 1], okRaw, '会话粘性 + 池跳选共同落在健康账号');

  // 收尾：把两个测试账号的池记录清掉，避免影响同进程内其他断言
  pool.revive(failedUid);
  pool.revive(okUid);
  channelPool._stickyClear();
});
