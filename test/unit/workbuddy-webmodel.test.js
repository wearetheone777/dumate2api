// test/unit/workbuddy-webmodel.test.js - 打卡候选模型序列 + 预算 + 退避（批次十一，hub v2.1.1 移植）
//
// 锁的行为：
//   1. 候选序列：env 显式序列整体优先且不重排；自动模式**免费优先**（探针实证
//      hy4flash-free 被网页沙箱接受，rate 0）+ flash 收尾；目录拉不到 → [flash]
//   2. runTurn：set_model 被拒 → **不 prompt**（拒绝按付费 Auto 计费）、本轮失败
//   3. 候选循环：额度/限流/模型类失败换下一个候选（create 与 turn 两阶段）；
//      风控 11140 立即停不换模型；轮数 = max(2, 候选数)
//   4. 预算：不足一轮 → phase='budget' 明确结论，不再有「跑几小时没动静」
//   5. 退避：只有 create/session 阶段补退避（turn 阶段已等满 waitMs，双重惩罚）
//
// 全部离线：_setRequestImpl 打桩出站 http；models.fetchModels 打桩目录。
// stub 恢复写在测试体内（文件加载时顶层恢复会被后续用例的再打桩覆盖，批次八教训）。
// 退避基数经 env 调成 50ms，端到端用例不被真实退避拖慢。
process.env.DUMATE_WORKBUDDY_WEB_RETRY_BACKOFF = '0.05';
const assert = require('assert');
const { test } = require('node:test');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-wb-webmodel');
process.env.DUMATE_ADMIN_DATA = TMP;

const webagent = require('../../src/workbuddy/webagent');
const models = require('../../src/workbuddy/models');

const ACCOUNT = {
  id: 9971, uid: 'uid-webm-1', nickname: '候选账号', region: 'global',
  accessToken: 'at', refreshToken: 'rt', enabled: true,
};
const LINK = 'https://acp.example.com/acp/conn-1';
const FREE = 'hy4flash-free';
const FLASH = 'deepseek-v4.1-flash';
const SSE_CHUNK = 'data: {"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}\n\n';

const realFetchModels = models.fetchModels;
function stubCatalog(rows) { models.fetchModels = async () => ({ ok: true, models: rows }); }

/** 端到端剧本：按建会话 body 里的 model 分派会话 id，便于断言轮次归属 */
function candidateScript({ setModelReject = [], createReject = null, pollFails = 2 } = {}) {
  return {
    'POST /console/as/conversations/': (rec) => {
      const b = JSON.parse(rec.body || '{}');
      if (createReject && !setModelReject.includes(b.model)) {
        return { status: createReject.status || 200, json: createReject.json || { code: createReject.code, msg: createReject.msg || '' } };
      }
      return { status: 200, json: { code: 0, data: { id: b.model === FREE ? 'conv-free' : 'conv-flash' } } };
    },
    'GET /console/as/conversations/conv-free/session': () => ({
      status: 200, json: { code: 0, data: { link: LINK, token: 'tok-1', sessionId: 'sess-1', cwd: '/workspace' } },
    }),
    'GET /console/as/conversations/conv-flash/session': () => ({
      status: 200, json: { code: 0, data: { link: LINK, token: 'tok-1', sessionId: 'sess-2', cwd: '/workspace' } },
    }),
    'GET /acp/conn-1': () => ({
      stream: true, headers: { 'acp-connection-id': 'conn-1' },
      lines: [SSE_CHUNK],
    }),
    'POST /acp/conn-1': (rec) => {
      const b = JSON.parse(rec.body || '{}');
      if (b.method === 'session/set_model' && setModelReject.includes(b.params.modelId)) {
        return { status: 400, json: {} };
      }
      return { status: 202, json: {} };
    },
    'GET /console/as/conversations/conv-free': () => ({ status: 200, json: { code: 0, data: { status: 'working' } } }),
    'GET /console/as/conversations/conv-flash': (function () {
      let poll = 0;
      return () => { poll++; return { status: 200, json: { code: 0, data: { status: poll >= pollFails ? 'completed' : 'working' } } }; };
    })(),
    'POST /console/as/conversations/conv-free/delete': () => ({ status: 200, json: { code: 0 } }),
    'POST /console/as/conversations/conv-flash/stop': () => ({ status: 200, json: { code: 0 } }),
    'POST /console/as/conversations/conv-flash/delete': () => ({ status: 200, json: { code: 0 } }),
  };
}

function fakeHttp(script, calls) {
  return function fakeRequest(opts, cb) {
    const rec = { method: opts.method, path: opts.path || '', headers: opts.headers || {}, body: null };
    (calls || []).push(rec);
    const key = Object.keys(script).find((k) => {
      const [m, p] = k.split(' ');
      return m === opts.method && rec.path.includes(p);
    });
    const spec = key ? script[key] : null;
    const handlers = {};
    const req = {
      on(ev, cb2) { handlers[ev] = cb2; return this; },
      write(b) { rec.body = String(b); },
      end() {
        setImmediate(() => {
          if (!spec) {
            const res = { statusCode: 404, headers: {}, on(ev, cb2) { if (ev === 'data') setImmediate(() => cb2(Buffer.from('not found'))); if (ev === 'end') setImmediate(() => cb2()); return res; }, resume() {} };
            return cb(res);
          }
          const out = typeof spec === 'function' ? spec(rec) : spec;
          if (out.error) {
            if (handlers.error) handlers.error(new Error(out.error));
            return;
          }
          if (out.stream) {
            const res = {
              statusCode: out.status || 200,
              headers: out.headers || {},
              setEncoding() {},
              on(ev, cb2) {
                if (ev === 'data') setImmediate(() => { for (const line of (out.lines || [])) cb2(Buffer.from(line)); });
                return res;
              },
              resume() {},
              destroy() {},
            };
            return cb(res);
          }
          const res = {
            statusCode: out.status || 200,
            headers: out.headers || {},
            on(ev, cb2) {
              if (ev === 'data') setImmediate(() => cb2(Buffer.from(out.json != null ? JSON.stringify(out.json) : '')));
              if (ev === 'end') setImmediate(() => cb2());
              return res;
            },
            resume() {},
            destroy() {},
          };
          cb(res);
        });
      },
      destroy() {},
      setTimeout() {},
    };
    return req;
  };
}

test('cleanCandidates：保序去重去空，不截断', () => {
  assert.deepStrictEqual(webagent.cleanCandidates(['b', 'a', 'b', '', ' a ', 'a']), ['b', 'a']);
  assert.deepStrictEqual(webagent.cleanCandidates([]), []);
  assert.deepStrictEqual(webagent.cleanCandidates(null), []);
});

test('webRetryBackoffMs：指数增长封顶；base<=0 关', () => {
  assert.strictEqual(webagent.webRetryBackoffMs(0, 5000, 30000), 5000);
  assert.strictEqual(webagent.webRetryBackoffMs(1, 5000, 30000), 10000);
  assert.strictEqual(webagent.webRetryBackoffMs(2, 5000, 30000), 20000);
  assert.strictEqual(webagent.webRetryBackoffMs(3, 5000, 30000), 30000, '封顶不再翻倍');
  assert.strictEqual(webagent.webRetryBackoffMs(9, 5000, 10000), 10000);
  assert.strictEqual(webagent.webRetryBackoffMs(3, 0, 30000), 0, 'base 0 = 显式关退避');
});

test('createRejectRetryable：额度/限流/模型类可换候选，其它终止', () => {
  assert.strictEqual(webagent.createRejectRetryable(14018, ''), true);
  assert.strictEqual(webagent.createRejectRetryable(6004, ''), true);
  assert.strictEqual(webagent.createRejectRetryable(6005, ''), true);
  assert.strictEqual(webagent.createRejectRetryable(null, 'insufficient credit'), true);
  assert.strictEqual(webagent.createRejectRetryable(null, '积分不足'), true);
  assert.strictEqual(webagent.createRejectRetryable(null, 'model not found'), true);
  assert.strictEqual(webagent.createRejectRetryable(1, 'param error'), false);
  assert.strictEqual(webagent.createRejectRetryable(null, ''), false);
});

test('dailyChatCandidates：env 显式序列整体优先且不重排（含去重）', async () => {
  process.env.DUMATE_WORKBUDDY_DAILY_MODELS = 'glm-x, hy4flash-free, glm-x, ';
  try {
    const r = await webagent.dailyChatCandidates('cn');
    assert.deepStrictEqual(r, ['glm-x', 'hy4flash-free'], '显式序列是操作者的优先级，免费优先逻辑不掺和');
  } finally { delete process.env.DUMATE_WORKBUDDY_DAILY_MODELS; }
});

test('dailyChatCandidates：自动模式免费优先 + flash 收尾；目录拉不到 → [flash] 兜底', async () => {
  stubCatalog([{ id: FREE, free: true, rate: 0 }, { id: 'hy4flash', free: false, rate: 0.03 }]);
  const r1 = await webagent.dailyChatCandidates('cn');
  assert.deepStrictEqual(r1, [FREE, FLASH], '免费模型在前（探针实证沙箱接受），flash 收尾保连登');
  // 目录异常（抛错）→ 兜底
  models.fetchModels = async () => { throw new Error('net down'); };
  const r2 = await webagent.dailyChatCandidates('cn');
  assert.deepStrictEqual(r2, [FLASH], '打卡不因目录抖动停摆');
  // 目录正常但没有免费模型 → flash
  stubCatalog([{ id: 'hy4flash', free: false, rate: 0.03 }]);
  const r3 = await webagent.dailyChatCandidates('cn');
  assert.deepStrictEqual(r3, [FLASH]);
});

test('runTurn：set_model 被拒 → 不 prompt、本轮失败、错误可见', async () => {
  const calls = [];
  webagent._setRequestImpl(fakeHttp({
    'GET /acp/conn-1': () => ({ stream: true, headers: { 'acp-connection-id': 'conn-1' }, lines: [] }),
    'POST /acp/conn-1': (rec) => {
      const b = JSON.parse(rec.body || '{}');
      if (b.method === 'session/set_model') return { status: 400, json: {} };
      return { status: 202, json: {} };
    },
  }, calls));
  const r = await webagent.runTurn({
    link: LINK, token: 'tok', sessionId: 'sess-9', cwd: '/workspace',
    prompt: 'Hi', model: FREE,
    pollStatus: async () => null,
    waitMs: 800, pollIntervalMs: 1, agent: null,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.setModelOk, false);
  assert.ok(/set_model 失败/.test(r.error), r.error);
  const rpcs = calls.filter((c) => c.method === 'POST' && c.path.includes('/acp/'));
  const methods = rpcs.map((c) => JSON.parse(c.body).method);
  assert.ok(!methods.includes('session/prompt'), 'set_model 失败绝不能发 prompt（拒绝按付费 Auto 计费）');
  assert.deepStrictEqual(methods, ['initialize', 'session/load', 'session/set_model']);
});

test('dailyActivity：免费候选 set_model 被拒 → 换 flash 成功（models_tried 两轮）', async () => {
  stubCatalog([{ id: FREE, free: true, rate: 0 }]);
  const calls = [];
  webagent._setRequestImpl(fakeHttp(candidateScript({ setModelReject: [FREE] }), calls));
  const patched = {};
  const a = { ...ACCOUNT, lastWebActivity: '' };
  try {
    const r = await webagent.dailyActivity(a, {
      authStore: { patch: (id, p) => { patched[id] = p; Object.assign(a, p); } },
      pollIntervalMs: 1, waitMs: 1500,
    });
    assert.strictEqual(r.ok, true, r.error || '');
    assert.strictEqual(r.attempts, 2);
    assert.deepStrictEqual(r.models_tried, [FREE, FLASH]);
    assert.ok(/deepseek-v4.1-flash/.test(r.msg), r.msg);
    assert.ok(calls.some((c) => c.path.endsWith('/conv-free/delete')), '失败轮 delete');
    assert.ok(calls.some((c) => c.path.endsWith('/conv-flash/stop')), '成功轮 stop');
    assert.ok(patched[ACCOUNT.id] && patched[ACCOUNT.id].lastWebActivity, '成功后落档案');
  } finally { models.fetchModels = realFetchModels; }
});

test('dailyActivity：全部候选 set_model 被拒 → 两轮后如实失败', async () => {
  stubCatalog([{ id: FREE, free: true, rate: 0 }]);
  const calls = [];
  webagent._setRequestImpl(fakeHttp(candidateScript({ setModelReject: [FREE, FLASH] }), calls));
  try {
    const r = await webagent.dailyActivity({ ...ACCOUNT, lastWebActivity: '' }, {
      authStore: { patch() {} }, pollIntervalMs: 1, waitMs: 800,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.attempts, 2, '轮数由候选数推出（每个候选一轮）');
    assert.strictEqual(r.phase, 'turn');
    assert.ok(/set_model/.test(r.error), r.error);
    assert.ok(calls.filter((c) => c.path.endsWith('/delete')).length >= 2, '每轮失败都收尾');
  } finally { models.fetchModels = realFetchModels; }
});

test('dailyActivity：create 阶段额度类拒绝（6004）→ 换候选重试', async () => {
  stubCatalog([{ id: FREE, free: true, rate: 0 }]);
  const calls = [];
  webagent._setRequestImpl(fakeHttp(candidateScript({
    createReject: { code: 6004, msg: 'usage exceeds frequency limit' },
    setModelReject: [],
  }), calls));
  try {
    const r = await webagent.dailyActivity({ ...ACCOUNT, lastWebActivity: '' }, {
      authStore: { patch() {} }, pollIntervalMs: 1, waitMs: 800,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.phase, 'create');
    assert.strictEqual(r.attempts, 2, '6004 可换候选：两个候选各试一轮');
    assert.deepStrictEqual(r.models_tried, [FREE, FLASH]);
    const creates = calls.filter((c) => c.method === 'POST' && c.path.includes('/console/as/conversations/') && !c.path.includes('/session') && !c.path.includes('/stop') && !c.path.includes('/delete'));
    assert.strictEqual(creates.length, 2, '两轮各建一次会话');
  } finally { models.fetchModels = realFetchModels; }
});

test('dailyActivity：11140 create 拒绝 → 立即停，不发第二轮 create', async () => {
  stubCatalog([{ id: FREE, free: true, rate: 0 }]);
  const calls = [];
  webagent._setRequestImpl(fakeHttp({
    'POST /console/as/conversations/': () => ({ status: 403, json: { code: 11140, msg: 'unusual activity' } }),
  }, calls));
  const patched = {};
  const a = { ...ACCOUNT, lastWebActivity: '' };
  try {
    const r = await webagent.dailyActivity(a, {
      authStore: { patch: (id, p) => { patched[id] = p; Object.assign(a, p); } },
      pollIntervalMs: 1, waitMs: 800,
    });
    assert.strictEqual(r.ok, false);
    assert.ok(/11140/.test(r.error) && /避让/.test(r.error), r.error);
    const creates = calls.filter((c) => c.method === 'POST' && c.path.includes('/console/as/conversations/') && c.path.endsWith('/console/as/conversations/'));
    assert.strictEqual(creates.length, 1, '风控立即停，不换模型');
    assert.ok(patched[ACCOUNT.id] && patched[ACCOUNT.id].webBlockedUntil > Date.now());
  } finally { models.fetchModels = realFetchModels; }
});

test('dailyActivity：预算不足一轮 → phase budget 明确结论', async () => {
  stubCatalog([{ id: FREE, free: true, rate: 0 }]);
  const calls = [];
  webagent._setRequestImpl(fakeHttp(candidateScript({}), calls));
  try {
    const r = await webagent.dailyActivity({ ...ACCOUNT, lastWebActivity: '' }, {
      authStore: { patch() {} }, pollIntervalMs: 1, waitMs: 800, budgetMs: 1000,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.phase, 'budget');
    assert.strictEqual(r.attempts, 0, '一轮都放不下，一次请求都没发');
    assert.strictEqual(calls.length, 0);
  } finally { models.fetchModels = realFetchModels; }
});

test('接线自证：编排器消费候选序列；免费判据来自实时目录', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/workbuddy/webagent.js'), 'utf8');
  assert.ok(src.includes('await dailyChatCandidates(region)'), 'dailyActivity 按候选序列跑');
  assert.ok(src.includes("require('./models').fetchModels"), '免费模型来自实时目录（catalog free 字段）');
  assert.ok(src.includes('DUMATE_WORKBUDDY_DAILY_MODELS'), 'env 显式序列入口存在');
  assert.ok(src.includes('setModelOk'), 'runTurn 追踪 set_model 结果');
});
