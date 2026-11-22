// test/unit/upstream-router.test.js - 通道分流与 availability 全通道判定（F7-2）
//
// availability 的契约：三条直连通道（qwenwork / traework / qoder）都必须走
// 各自 index.js 的 status() 判 ready——qoder 漏分支时零账号也报 ok:true，
// 这条测试就是给它上的锁。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 通道 status() 按 mtime 读 data/ 下的账号文件——指向空临时目录即「零账号」
const { tmpDir } = require('../helpers/tmpdir');
const tmp = tmpDir('dumate-router');
process.env.DUMATE_ADMIN_DATA = tmp;

const router = require('../../src/upstream-router');

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* tmp 清理失败不影响结果 */ }
});

test('resolve：三通道前缀分流 + 无前缀归搭子 + 未知前缀报错不回落', () => {
  assert.strictEqual(router.resolve('qoder/gfmodel').channel, 'qoder');
  assert.strictEqual(router.resolve('qoder/gfmodel').model, 'gfmodel');
  assert.strictEqual(router.resolve('qwen/pro').channel, 'qwenwork');
  assert.strictEqual(router.resolve('traework/glm-5.2').channel, 'traework');
  assert.strictEqual(router.resolve('glm-5').channel, 'dumate');
  assert.ok(router.resolve('qwn/pro').error, '拼错的前缀要报错而不是静默落到搭子');
});

test('resolve：直连通道 target.direct 为真（上层须调 provider 而非转发）', () => {
  // 注意：通道 id 与路由前缀不同（qwenwork 通道的前缀是 qwen）
  const cases = [
    ['qwenwork', router.QWEN_PREFIX],
    ['traework', router.TRAEWORK_PREFIX],
    ['qoder', router.QODER_PREFIX],
  ];
  for (const [ch, prefix] of cases) {
    const t = router.resolve(`${prefix}/m`).target;
    assert.strictEqual(t.direct, true, ch);
    assert.strictEqual(t.needsBudget, true, ch);
  }
});

test('availability：零账号的 qoder 必须报不可用（F7-2 修复点）', () => {
  const r = router.availability('qoder');
  assert.strictEqual(r.ok, false, '空账号池不该 ok');
  assert.strictEqual(typeof r.reason, 'string');
  assert.ok(r.reason.length > 0);
});

test('availability：三条直连通道判定形状一致（ready + reason）', () => {
  for (const ch of ['qwenwork', 'traework', 'qoder']) {
    const r = router.availability(ch);
    assert.ok(typeof r.ok === 'boolean', ch);
    if (!r.ok) assert.ok(typeof r.reason === 'string' && r.reason.length, `${ch} 失败时必须给原因`);
  }
});

test('availability：qoder 池里有凭证完整的账号时报可用', () => {
  fs.writeFileSync(path.join(tmp, 'qoder-accounts.json'), JSON.stringify({
    accounts: [{ id: 1, nickname: 'n', accessToken: 'at', refreshToken: 'rt', enabled: true }],
  }), 'utf8');
  const r = router.availability('qoder');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('availability：凭证不完整的账号不算可用（fail-honest）', () => {
  fs.writeFileSync(path.join(tmp, 'traework-accounts.json'), JSON.stringify({
    accounts: [{ id: 1, nickname: 'n', enabled: true }], // 缺 token
  }), 'utf8');
  assert.strictEqual(router.availability('traework').ok, false);
});

test('exposedFor：直连通道模型名加前缀，避免与搭子撞名', () => {
  assert.deepStrictEqual(router.exposedFor('qoder', ['a', 'b']), ['qoder/a', 'qoder/b']);
  assert.deepStrictEqual(router.exposedFor('qwenwork', ['pro']), ['qwen/pro']);
  assert.deepStrictEqual(router.exposedFor('dumate', ['glm-5']), ['glm-5']);
});
