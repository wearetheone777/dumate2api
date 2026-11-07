// test/unit/trae-fusion-degrade-flow.test.js - 降级编排端到端（离线打桩）
//
// 注入 sendOnce，验证：默认关闭不重试 / 启用后只重试一次且带 onDegraded /
// 已吐内容不降级 / 非额度错误不降级 / 双失败保留根因。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-trae-degrade-'));
process.env.DUMATE_ADMIN_DATA = tmp;
const runtime = require('../../src/trae-runtime');
const tw = require('../../src/traework');

test.after(() => {
  tw.internals.resetSendOnce();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结果 */ }
});

function enable(cfg = {}) {
  runtime._resetForTest();
  runtime.Store({
    degrade: { enabled: true, fallbackModel: 'deepseek-v4.1-flash', fallbackRegion: '', onQuota: true, onUpgrade: true, ...cfg },
  });
}
function disable() {
  runtime._resetForTest();
  runtime.Store({ degrade: { enabled: false } });
}

test('默认关闭：原错误直接上抛，不重试、不回调降级头', async () => {
  disable();
  let calls = 0;
  let degraded = '';
  tw.internals.setSendOnce(async () => { calls++; throw Object.assign(new Error('额度不足'), { statusCode: 402 }); });
  await assert.rejects(
    () => tw.send({ model: 'traework/glm-5.2' }, null, { onDegraded: (x) => { degraded = x; } }),
    /额度不足/,
  );
  assert.strictEqual(calls, 1);
  assert.strictEqual(degraded, '');
});

test('额度耗尽：换备用模型重试一次，回调响应头文本且结果带 degraded', async () => {
  enable();
  const seen = [];
  let header = '';
  tw.internals.setSendOnce(async (payload, onChunk, opts) => {
    seen.push({ model: payload.model, region: opts.region });
    if (seen.length === 1) throw Object.assign(new Error('余额不足'), { statusCode: 402 });
    return { choices: [{ message: { content: 'ok' } }], usage: {} };
  });
  const out = await tw.send({ model: 'traework/glm-5.2', messages: [] }, null, {
    onDegraded: (x) => { header = x; },
  });
  assert.deepStrictEqual(seen.map((x) => x.model), ['traework/glm-5.2', 'traework/deepseek-v4.1-flash']);
  assert.match(header, /glm-5.2 -> deepseek-v4.1-flash \(quota\)/);
  assert.strictEqual(out.degraded.reason, 'quota');
  assert.strictEqual(out.choices[0].message.content, 'ok');
});

test('已吐出内容：流式首帧之后失败不降级（客户端收不回半段回答）', async () => {
  enable();
  let calls = 0;
  tw.internals.setSendOnce(async (payload, onChunk) => {
    calls++;
    if (onChunk) onChunk('data: {"x":1}');
    throw Object.assign(new Error('余额不足'), { statusCode: 402 });
  });
  await assert.rejects(() => tw.send({ model: 'traework/glm-5.2' }, () => {}), /余额不足/);
  assert.strictEqual(calls, 1);
});

test('限流错误不降级；双失败时保留第一次根因', async () => {
  enable();
  let calls = 0;
  tw.internals.setSendOnce(async () => { calls++; throw Object.assign(new Error('RESOURCE_LIMIT isQueued'), { statusCode: 429 }); });
  await assert.rejects(() => tw.send({ model: 'traework/glm-5.2' }, null), /RESOURCE_LIMIT/);
  assert.strictEqual(calls, 1);

  calls = 0;
  tw.internals.setSendOnce(async () => {
    calls++;
    throw calls === 1
      ? Object.assign(new Error('原模型额度耗尽'), { statusCode: 402 })
      : Object.assign(new Error('备用模型 400'), { statusCode: 400 });
  });
  await assert.rejects(
    () => tw.send({ model: 'traework/glm-5.2' }, null),
    (e) => e.statusCode === 400 && /原模型额度耗尽/.test(e.message) && /备用模型 400/.test(e.message),
  );
  assert.strictEqual(calls, 2);
});
