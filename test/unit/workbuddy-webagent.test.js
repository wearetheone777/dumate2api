// test/unit/workbuddy-webagent.test.js - 网页 agent 会话打卡（ACP over streamable HTTP）
//
// 协议剧本取自 workbuddy2api-hub 的 wb_webagent.py（2026-11-05 融合）：
// 建会话只是排队（#90）→ 取沙箱 link/token → SSE 通道（Acp-Connection-Id）
// → initialize → session/load → session/set_model（不设会按付费档计费）
// → session/prompt → 轮询 console 状态到 completed → 收尾。
// 全部离线：_setRequestImpl 打桩出站 http，按 (method, path) 分派剧本。
// 运行：node --test test/unit/workbuddy-webagent.test.js
const assert = require('assert');
const { test } = require('node:test');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-wb-web-'));
process.env.DUMATE_ADMIN_DATA = TMP;

const webagent = require('../../src/workbuddy/webagent');

const ACCOUNT = {
  id: 9961, uid: 'uid-web-1', nickname: '网页账号', region: 'global',
  accessToken: 'at', refreshToken: 'rt', enabled: true,
};

/**
 * 多请求剧本桩。script: { 'METHOD /path片段': (body) => ({status, headers, json, stream}) }
 * 返回 {calls: [{method, path, headers, body}]}。
 */
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
          // 证书/连接类错误：end 时触发 error handler（Node TLS 层的真实形态）
          if (out.error) {
            if (handlers.error) handlers.error(new Error(out.error));
            return;
          }
          if (out.stream) {
            // SSE 长连接：推数据后保持打开（close 时 destroy）
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

const LINK = 'https://sandbox.example.test/acp/conn-1';

test('runTurn：initialize → session/load → set_model → prompt 的 JSON-RPC 序列与 completed 判定', async () => {
  const calls = [];
  let poll = 0;
  webagent._setRequestImpl(fakeHttp({
    'GET /acp/conn-1': () => ({
      stream: true,
      headers: { 'acp-connection-id': 'conn-1' },
      lines: [
        'data: {"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk"}}}\n\n',
        'data: {"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}\n\n',
      ],
    }),
    'POST /acp/conn-1': (rec) => {
      // JSON-RPC 形状校验在断言段做（calls 里拿 body）
      return { status: 202, json: {} };
    },
    'GET /console/as/conversations/conv-1': () => {
      poll++;
      return { status: 200, json: { code: 0, data: { status: poll >= 2 ? 'completed' : 'working' } } };
    },
  }, calls));
  const r = await webagent.runTurn({
    link: LINK, token: 'tok-1', sessionId: 'sess-9', cwd: '/workspace',
    prompt: 'Hi', model: 'deepseek-v4.1-flash',
    pollStatus: async () => null,   // 占位——真实轮询在 dailyActivity；这里直接测 channel 层序列
    waitMs: 3000, pollIntervalMs: 1,
    agent: null,
  });
  // runTurn 自身不知道会话 id 的 console 路径——pollStatus 注入 null 时靠超时；
  // 这里只锁「四条 JSON-RPC 都发出且形状正确」，completed 判定在 dailyActivity 测
  const rpcs = calls.filter((c) => c.method === 'POST' && c.path.includes('/acp/conn-1'));
  assert.strictEqual(rpcs.length, 4, `应发出 4 条 JSON-RPC，实际 ${rpcs.length}`);
  const bodies = rpcs.map((c) => JSON.parse(c.body));
  assert.deepStrictEqual(bodies.map((b) => b.method),
    ['initialize', 'session/load', 'session/set_model', 'session/prompt']);
  assert.deepStrictEqual(bodies.map((b) => b.id), [1, 2, 3, 4]);
  assert.ok(bodies.every((b) => b.jsonrpc === '2.0'));
  assert.strictEqual(bodies[1].params.sessionId, 'sess-9');
  assert.strictEqual(bodies[1].params.cwd, '/workspace');
  assert.strictEqual(bodies[2].params.modelId, 'deepseek-v4.1-flash', '不设模型会按付费档计费');
  assert.deepStrictEqual(bodies[3].params.prompt, [{ type: 'text', text: 'Hi' }]);
  assert.strictEqual(rpcs[1].headers['Acp-Connection-Id'], 'conn-1', 'POST 必须带连接 id');
  assert.strictEqual(rpcs[0].headers.Authorization, 'Bearer tok-1');
  assert.strictEqual(r.updates, 2, 'SSE 两条 session/update 都被计数');
  assert.strictEqual(r.chunks, 1, '只有 agent_message_chunk 计入输出段');
});

test('dailyActivity：全编排成功——completed 收尾 stop 保留 + 档案落 lastWebActivity', async () => {
  let poll = 0;
  const calls = [];
  webagent._setRequestImpl(fakeHttp({
    'POST /console/as/conversations/': () => ({ status: 200, json: { code: 0, data: { id: 'conv-7' } } }),
    'GET /console/as/conversations/conv-7/session': () => ({
      status: 200, json: { code: 0, data: { link: LINK, token: 'tok-9', sessionId: 'sess-9', cwd: '/workspace' } },
    }),
    'GET /acp/conn-1': () => ({
      stream: true, headers: { 'acp-connection-id': 'conn-1' },
      lines: ['data: {"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}\n\n'],
    }),
    'POST /acp/conn-1': () => ({ status: 202, json: {} }),
    'GET /console/as/conversations/conv-7': () => {
      poll++;
      return { status: 200, json: { code: 0, data: { status: poll >= 2 ? 'completed' : 'working' } } };
    },
    'POST /console/as/conversations/conv-7/stop': () => ({ status: 200, json: { code: 0 } }),
  }, calls));
  const patched = {};
  const a = { ...ACCOUNT, lastWebActivity: '' };
  const r = await webagent.dailyActivity(a, {
    authStore: { patch: (id, p) => { patched[id] = p; Object.assign(a, p); } },
    pollIntervalMs: 1, waitMs: 5000,
  });
  assert.strictEqual(r.ok, true, r.error || '');
  assert.strictEqual(r.phase, 'turn');
  assert.ok(/1 段输出/.test(r.msg), r.msg);
  assert.ok(patched[ACCOUNT.id] && patched[ACCOUNT.id].lastWebActivity, '档案应记录打卡时间');
  const stop = calls.find((c) => c.path.endsWith('/conv-7/stop'));
  const del = calls.find((c) => c.path.endsWith('/conv-7/delete'));
  assert.ok(stop, '成功的一轮 stop 保留');
  assert.ok(!del, '成功的一轮不 delete');
  // 建会话 body 按 hub 抓包字面
  const create = calls.find((c) => c.method === 'POST' && c.path.endsWith('/console/as/conversations/'));
  const createBody = JSON.parse(create.body);
  assert.strictEqual(createBody.conversationOrigin, 'workbuddy-app');
  assert.deepStrictEqual(createBody.plugins, [{ name: 'weixinpay', marketplace: 'codebuddy-builtin' }]);
  assert.strictEqual(createBody.model, 'deepseek-v4.1-flash');
});

test('dailyActivity：当日幂等（lastWebActivity 是今天 → skipped）', async () => {
  const d = new Date();
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const r = await webagent.dailyActivity(
    { ...ACCOUNT, lastWebActivity: `${local} 08:00:00` },
    { authStore: { patch() {} } },
  );
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.ok, true);
});

test('dailyActivity：跑失败的一轮收尾用 delete（不在网页历史堆「Hi」）', async () => {
  const calls = [];
  webagent._setRequestImpl(fakeHttp({
    'POST /console/as/conversations/': () => ({ status: 200, json: { code: 0, data: { id: 'conv-8' } } }),
    'GET /console/as/conversations/conv-8/session': () => ({
      status: 200, json: { code: 0, data: { link: LINK, token: 'tok-9', sessionId: 'sess-9' } },
    }),
    'GET /acp/conn-1': () => ({ stream: true, headers: { 'acp-connection-id': 'conn-1' }, lines: [] }),
    'POST /acp/conn-1': () => ({ status: 500, json: { code: 1 } }),
    'POST /console/as/conversations/conv-8/delete': () => ({ status: 200, json: { code: 0 } }),
  }, calls));
  const r = await webagent.dailyActivity({ ...ACCOUNT, lastWebActivity: '' }, {
    authStore: { patch() {} }, pollIntervalMs: 1, waitMs: 800,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.phase, 'turn');
  assert.ok(calls.some((c) => c.path.endsWith('/conv-8/delete')), '失败的一轮 delete 清理');
});

test('dailyPromptOf：opts 优先；env 池生效；没配用内置问候池', () => {
  assert.strictEqual(webagent.dailyPromptOf({ prompt: 'custom' }), 'custom');
  process.env.DUMATE_WORKBUDDY_WEB_PROMPTS = '甲, 乙；丙';
  try {
    for (let i = 0; i < 10; i++) {
      assert.ok(['甲', '乙', '丙'].includes(webagent.dailyPromptOf()), webagent.dailyPromptOf());
    }
    delete process.env.DUMATE_WORKBUDDY_WEB_PROMPTS;
    // 内置池：非空且全部是短问候（不硬编码唯一值——固定句是指纹）
    assert.ok(webagent.dailyPromptOf().length > 0);
    assert.ok(webagent.dailyPromptOf().length <= 16);
  } finally {
    delete process.env.DUMATE_WORKBUDDY_WEB_PROMPTS;
  }
});

test('isActiveLimit：HTTP 429 + code 10105 判活跃会话已满', () => {
  assert.strictEqual(webagent.isActiveLimit(429, '{"code":10105,"message":"you have reached the maximum number of active conversations(10)"}'), true);
  assert.strictEqual(webagent.isActiveLimit(429, 'maximum number of active'), true);
  assert.strictEqual(webagent.isActiveLimit(500, 'boom'), false);
  assert.strictEqual(webagent.isActiveLimit(429, 'other'), false);
});

test('dailyActivity：撞 11140 记 webBlockedUntil 避让，期内打卡跳过（hub v1.9.0）', async () => {
  const patched = {};
  const a = { ...ACCOUNT, lastWebActivity: '' };
  const authStub = { patch: (id, p) => { patched[id] = p; Object.assign(a, p); } };
  // 第一轮：建会话被 11140 风控拒绝
  webagent._setRequestImpl(fakeHttp({
    'POST /console/as/conversations/': () => ({ status: 403, json: { code: 11140, msg: 'unusual activity' } }),
  }));
  const r1 = await webagent.dailyActivity(a, { authStore: authStub });
  assert.strictEqual(r1.ok, false);
  assert.ok(/11140/.test(r1.error) && /避让/.test(r1.error), r1.error);
  assert.ok(patched[ACCOUNT.id] && patched[ACCOUNT.id].webBlockedUntil > Date.now(), '档案应记避让到期时刻');
  // 第二轮：避让期内直接跳过，不发任何请求
  webagent._setRequestImpl((opts, cb) => { throw new Error('避让期内不应发请求'); });
  const r2 = await webagent.dailyActivity(a, { authStore: authStub });
  assert.strictEqual(r2.skipped, true);
  assert.strictEqual(r2.phase, 'restricted');
  assert.strictEqual(r2.ok, true, '避让跳过与当日幂等同形态，不算失败');
});

test('dailyActivity：证书类失败降级 /v2/report（默认关，opts.certFallback 开）', async () => {
  const activity = require('../../src/workbuddy/activity');
  const calls = [];
  webagent._setRequestImpl(fakeHttp({
    'POST /console/as/conversations/': () => ({ status: 200, json: { code: 0, data: { id: 'conv-9' } } }),
    'GET /console/as/conversations/conv-9/session': () => ({
      status: 200, json: { code: 0, data: { link: LINK, token: 'tok-9', sessionId: 'sess-9' } },
    }),
    // ACP 沙箱的 EdgeOne 通配证书：TLS 层真实错误文案（hub #645）
    'GET /acp/conn-1': () => ({ error: 'unable to verify the first certificate' }),
    'POST /console/as/conversations/conv-9/delete': () => ({ status: 200, json: { code: 0 } }),
  }, calls));
  // activity 的出站同样打桩：/v2/report 成功
  activity._setRequestImpl((opts, cb) => {
    const res = {
      statusCode: 200,
      setEncoding() {},
      on(ev, cb2) { if (ev === 'data') setImmediate(() => cb2(Buffer.from(JSON.stringify({ code: 0 })))); if (ev === 'end') setImmediate(() => cb2()); return res; },
    };
    setImmediate(() => cb(res));
    return { on() { return this; }, write() {}, end() {}, destroy() {}, setTimeout() {} };
  });
  // 默认关：同样失败如实报，不降级
  const rOff = await webagent.dailyActivity({ ...ACCOUNT, id: 9962, lastWebActivity: '' }, {
    authStore: { patch() {} }, pollIntervalMs: 1, waitMs: 800,
  });
  assert.strictEqual(rOff.ok, false);
  assert.strictEqual(rOff.phase, 'turn');
  // 开关打开（opts 直开）：降级走 /v2/report 成功
  const rOn = await webagent.dailyActivity({ ...ACCOUNT, id: 9963, lastWebActivity: '' }, {
    authStore: { patch() {} }, pollIntervalMs: 1, waitMs: 800, certFallback: true,
  });
  assert.strictEqual(rOn.ok, true, JSON.stringify(rOn));
  assert.strictEqual(rOn.phase, 'cert-fallback');
  assert.ok(/降级/.test(rOn.msg), rOn.msg);
});
