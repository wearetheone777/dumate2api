// test/unit/qwen-maas.test.js - G1 MaaS 直连模块（2026-11-27）
//
// 锁三件事：默认关零凭证访问；状态元数据不泄露 secret；模型名归一化。
// 真凭证读取与 HTTP 请求已在 WSL 真机验证，离线测试不碰任何本机凭证文件。
const { test } = require('node:test');
const assert = require('assert');

const maasPath = require.resolve('../../src/qwenwork/maas');

function freshMaas(env = {}) {
  delete require.cache[maasPath];
  const prev = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const mod = require('../../src/qwenwork/maas');
  return { mod, restore: () => { process.env = prev; delete require.cache[maasPath]; } };
}

test('默认关：enabled=false，meta 不触碰凭证，available=false', () => {
  const { mod, restore } = freshMaas({ DUMATE_QWENWORK_MAAS: undefined });
  try {
    assert.strictEqual(mod.enabled(), false);
    assert.strictEqual(mod.available(), false);
    assert.deepStrictEqual(mod.meta(), { enabled: false, available: false });
  } finally { restore(); }
});

test('meta 禁用路径是纯函数：不返回 key/到期/baseUrl', () => {
  const { mod, restore } = freshMaas({ DUMATE_QWENWORK_MAAS: undefined });
  try {
    const m = mod.meta();
    assert.deepStrictEqual(Object.keys(m).sort(), ['available', 'enabled']);
    assert.ok(!JSON.stringify(m).includes('accessKey'));
  } finally { restore(); }
});

test('normalizeModel：别名与免费档都收敛到同一个上游键', () => {
  const { mod, restore } = freshMaas({ DUMATE_QWENWORK_MAAS: undefined });
  try {
    assert.strictEqual(mod.normalizeModel('qwen/minimax-m3.1-flash'), mod.FREE_MODEL);
    assert.strictEqual(mod.normalizeModel('minimax3.1flash'), mod.FREE_MODEL);
    assert.strictEqual(mod.normalizeModel('qwen/pro'), 'pro');
  } finally { restore(); }
});

test('invalidate 可调用且不会抛；模块只暴露安全接口', () => {
  const { mod, restore } = freshMaas({ DUMATE_QWENWORK_MAAS: undefined });
  try {
    assert.doesNotThrow(() => mod.invalidate());
    for (const fn of ['enabled', 'available', 'meta', 'normalizeModel', 'send', 'invalidate']) {
      assert.strictEqual(typeof mod[fn], 'function');
    }
  } finally { restore(); }
});
