// test/unit/body-limit.test.js - 请求体超限「先回 413、再限时排空」（P1-7）
//
// 出处：docs/WORKBUDDY-FUSION.md P1-7（hub #799）。原 server.js 的 readBody
// 要等整个上传结束才 resolve，于是 413 会被拖到上传完成——中途 RST 直接让
// 客户端只看到「连接被重置」，把它当瞬态错误重试/换号重放。
//
// 本套件用最小 Readable 冒充 IncomingMessage（只需要 on/data/end/resume/destroy
// + 三个标记位），锁住：
//   1. 正常请求原样返回字符串；预读缓存（_rawBody）优先、_bodyTooLarge 短路
//   2. 超限**立刻** resolve(null)，不等 'end'
//   3. 排空有时限：到期 destroy；`DUMATE_BODY_DRAIN_MS=0` 时立刻 destroy
//   4. 超限回调只调一次，且埋点异常不影响结果
//
// 运行：node --test test/unit/body-limit.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');

const bodyLimit = require('../../src/body-limit');

/** 最小假 IncomingMessage：可控地「滴」数据 */
function fakeReq() {
  const r = new Readable({ read() {} });
  r._rawBody = undefined;
  r._bodyTooLarge = undefined;
  r.destroyed = false;
  r.destroyCalls = 0;
  r.resumeCalled = 0;
  const origDestroy = r.destroy.bind(r);
  r.destroy = (...a) => { r.destroyCalls++; return origDestroy(...a); };
  const origResume = r.resume.bind(r);
  r.resume = (...a) => { r.resumeCalled++; return origResume(...a); };
  return r;
}

const tick = () => new Promise((r) => setImmediate(r));

test('正常请求：拼成字符串返回', async () => {
  const req = fakeReq();
  const p = bodyLimit.readBody(req, { maxBytes: 1000 });
  req.push('{"model":');
  req.push('"glm-5.3"}');
  req.push(null);
  assert.strictEqual(await p, '{"model":"glm-5.3"}');
  assert.ok(!req._bodyTooLarge);
});

test('预读缓存优先（鉴权阶段为模型白名单读过 body）', async () => {
  const req = fakeReq();
  req._rawBody = '{"cached":true}';
  const got = await bodyLimit.readBody(req, { maxBytes: 10 });
  assert.strictEqual(got, '{"cached":true}');
});

test('_bodyTooLarge 已标记时直接短路（流只能消费一次）', async () => {
  const req = fakeReq();
  req._bodyTooLarge = true;
  assert.strictEqual(await bodyLimit.readBody(req, { maxBytes: 10 }), null);
});

test('超限：**不等 end** 就 resolve(null)', async () => {
  const req = fakeReq();
  const p = bodyLimit.readBody(req, { maxBytes: 64, drain: 0 });
  req.push('x'.repeat(100));
  // 注意：没有 push(null)——模拟「客户端还在传」，超限判定不该等它
  assert.strictEqual(await p, null);
  assert.strictEqual(req._bodyTooLarge, true);
  assert.ok(req.resumeCalled > 0, '超限后要 resume 排空');
  assert.ok(req.destroyCalls > 0, 'drain=0 时立刻 destroy');
});

test('超限：多字节块累计判定，恰好等于上限不算超限', async () => {
  const exact = fakeReq();
  const p1 = bodyLimit.readBody(exact, { maxBytes: 8, drain: 0 });
  exact.push('12345678');
  exact.push(null);
  assert.strictEqual(await p1, '12345678', '等于上限应通过');

  const over = fakeReq();
  const p2 = bodyLimit.readBody(over, { maxBytes: 8, drain: 0 });
  over.push('12345678');
  over.push('9');
  assert.strictEqual(await p2, null);
});

test('排空有时限：设定的 ms 之后 destroy（不必读完整个上传）', async () => {
  const req = fakeReq();
  const p = bodyLimit.readBody(req, { maxBytes: 16, drain: 30 });
  req.push('y'.repeat(32));
  assert.strictEqual(await p, null);
  assert.strictEqual(req.destroyCalls, 0, '刚超限时不该立刻 destroy（先给响应机会）');
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(req.destroyCalls > 0, `排空到期应 destroy，实际 ${req.destroyCalls}`);
});

test('onTooLarge 只调一次，埋点抛错不影响结果', async () => {
  let calls = 0;
  const req = fakeReq();
  const p = bodyLimit.readBody(req, {
    maxBytes: 4,
    drain: 0,
    onTooLarge: () => { calls++; throw new Error('埋点炸了'); },
  });
  req.push('12345');
  req.push('67890');
  assert.strictEqual(await p, null);
  assert.strictEqual(calls, 1, '超限只报一次');
});

test('maxBodyBytes / drainMs：env 口径与默认值', () => {
  const oldMb = process.env.DUMATE_MAX_BODY_MB;
  const oldDrain = process.env.DUMATE_BODY_DRAIN_MS;
  try {
    delete process.env.DUMATE_MAX_BODY_MB;
    assert.strictEqual(bodyLimit.maxBodyBytes(), 32 * 1024 * 1024);
    process.env.DUMATE_MAX_BODY_MB = '8';
    assert.strictEqual(bodyLimit.maxBodyBytes(), 8 * 1024 * 1024);
    process.env.DUMATE_MAX_BODY_MB = 'abc';
    assert.strictEqual(bodyLimit.maxBodyBytes(), 32 * 1024 * 1024, '非法值回落默认而不是 0');

    delete process.env.DUMATE_BODY_DRAIN_MS;
    assert.strictEqual(bodyLimit.drainMs(), bodyLimit.DEFAULT_DRAIN_MS);
    process.env.DUMATE_BODY_DRAIN_MS = '0';
    assert.strictEqual(bodyLimit.drainMs(), 0);
    process.env.DUMATE_BODY_DRAIN_MS = '-5';
    assert.strictEqual(bodyLimit.drainMs(), bodyLimit.DEFAULT_DRAIN_MS);
  } finally {
    if (oldMb === undefined) delete process.env.DUMATE_MAX_BODY_MB;
    else process.env.DUMATE_MAX_BODY_MB = oldMb;
    if (oldDrain === undefined) delete process.env.DUMATE_BODY_DRAIN_MS;
    else process.env.DUMATE_BODY_DRAIN_MS = oldDrain;
  }
});

test('drain()：流走完即 resolve（end 或 aborted 都算）', async () => {
  const a = fakeReq();
  const pa = bodyLimit.drain(a);
  a.push('z');
  a.push(null);
  await pa;
  const b = fakeReq();
  const pb = bodyLimit.drain(b);
  b.emit('aborted');
  await pb;
  assert.ok(true);
});
