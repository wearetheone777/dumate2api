// test/verify-expiring-fefo.js - 三家通道 FEFO 选号的端到端验证（离线）
//
// 为什么要端到端而不是只测 src/expiring.js：Qoder 的 FEFO 落地即死
// （fefoUidSet 读 account_id、账本写 accountId，字段名对不上 → 集合恒空
//  → 从未生效），根因是当时的单测只覆盖池层的 expiring 过滤（直接传构造的
// Set），没有从「数据源 → 通道选号函数」这一段。这里补上：写一份真实形状
// 的快照，调用**通道自己的** fefoUidSet()，断言它推导出的 uid 集合正确。
// 通道里的转换（uidOf 前缀、数字↔字符串 id）再写错，这里当场红。
//
// 不依赖任何运行中的服务，不需要账号与网络：只喂临时快照文件。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fefo-e2e-'));
// 隔离：快照文件与数据目录都指到临时位置，绝不碰真实 data/
process.env.DUMATE_EXPIRING_SNAPSHOT_FILE = path.join(TMP, 'snapshot.json');
process.env.DUMATE_ADMIN_DATA = TMP;
process.env.DUMATE_POOL_STATE = path.join(TMP, 'pool-state.json');

const snap = require('../src/expiring');
const channelPool = require('../src/channel-pool');

let pass = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✔ ${name}`); }
  catch (e) { console.log(`  ✖ ${name}\n      ${e.message}`); process.exitCode = 1; }
}

const HOUR = 3600 * 1000;

console.log('=== 千问通道 fefoUidSet ===');
{
  // 账号 id 用数字与字符串混着写（千问管理端存的是字符串 id）
  snap.update('qwenwork', [
    { accountId: 1, nearest: Date.now() + 2 * HOUR },
    { accountId: '2', nearest: Date.now() + 20 * 86400000 },
    { accountId: 3, nearest: Date.now() + 400 * 86400000 }, // 窗口外
  ]);
  const qwen = require('../src/qwenwork/index.js');
  const set = qwen.fefoUidSet();
  check('临期账号转成 qwenwork:<id> 的池 uid', () => {
    assert.ok(set instanceof Set, '应返回 Set');
    assert.ok(set.has('qwenwork:1'), `应含 qwenwork:1，实得 ${[...set]}`);
    assert.ok(set.has('qwenwork:2'), `应含 qwenwork:2（字符串 id 同形）`);
  });
  check('窗口外账号不进集合', () => {
    assert.strictEqual(set.has('qwenwork:3'), false);
  });
  check('uid 前缀与 channelPool.uidOf 一致', () => {
    assert.strictEqual(
      [...set].includes(channelPool.uidOf('qwenwork', 1)), true,
      '通道转换必须与池的键位同一形式，否则 expiring.has 恒 false');
  });
}

console.log('=== TRAE 通道 fefoUidSet ===');
{
  snap.update('traework', [
    { accountId: 7, nearest: Date.now() + 3 * HOUR },
  ]);
  const trae = require('../src/traework/index.js');
  const set = trae.fefoUidSet();
  check('临期账号转成 traework:<id>', () => {
    assert.ok(set.has('traework:7'), `应含 traework:7，实得 ${[...set]}`);
    assert.strictEqual(set.has('qwenwork:1'), false, '不能串到别的通道');
  });
}

console.log('=== WorkBuddy 通道 fefoUidSet ===');
{
  snap.update('workbuddy', [
    { accountId: 3, nearest: Date.now() + 5 * HOUR },
  ]);
  const wb = require('../src/workbuddy/index.js');
  const set = wb.fefoUidSet();
  check('临期账号转成 workbuddy:<id>', () => {
    assert.ok(set.has('workbuddy:3'), `应含 workbuddy:3，实得 ${[...set]}`);
    assert.strictEqual(set.has('traework:7'), false, '不能串到别的通道');
  });
}

console.log('=== 搭子 web-pool FEFO（数字 id 形式）===');
{
  // 搭子 pool.pick 的候选是数字 id，快照字符串 id 要 Map 成数字
  snap.update('dumate', [{ accountId: 5, nearest: Date.now() + 6 * 86400000 }]);
  const ids = snap.accountIds('dumate');
  const numSet = new Set([...ids].map(Number));
  check('字符串 id 转回数字（与 pool.pick 候选同形）', () => {
    assert.strictEqual(numSet.has(5), true, '数字 5 应命中');
    assert.strictEqual(numSet.has('5'), false, '池按数字比较，字符串命中不了');
  });
}

console.log('=== FEFO 全关（env=0）时 fefoUidSet 返回 null ===');
{
  const prev = process.env.DUMATE_QWENWORK_FEFO_DAYS;
  process.env.DUMATE_QWENWORK_FEFO_DAYS = '0';
  try {
    const qwen = require('../src/qwenwork/index.js');
    check('关窗口 → null（普通轮询，不报错）', () => {
      assert.strictEqual(qwen.fefoUidSet(), null);
    });
  } finally {
    if (prev == null) delete process.env.DUMATE_QWENWORK_FEFO_DAYS;
    else process.env.DUMATE_QWENWORK_FEFO_DAYS = prev;
  }
}

console.log('=== 无临期账号时 fefoUidSet 返回 null ===');
{
  snap.update('traework', [{ accountId: 99, nearest: Date.now() + 100 * 86400000 }]);
  const trae = require('../src/traework/index.js');
  check('窗口内无临期 → null', () => {
    assert.strictEqual(trae.fefoUidSet(), null);
  });
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
console.log(`\n通过 ${pass} 项${process.exitCode ? '（有失败）' : '，全部绿'}`);
