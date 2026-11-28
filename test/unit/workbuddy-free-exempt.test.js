// test/unit/workbuddy-free-exempt.test.js - 免费模型豁免额度护栏（批次五）
//
// 出处：计划 P2「免费模型豁免」（hub v2.2.2）：creditFloor / guard.threshold
// 对**确认免费**的模型放行——免费请求不消耗套餐余额，低余额账号打免费模型
// 既不失败也不花钱，被拦纯属误伤。
//
// 判据 models.isFreeModel 两层数据源：① 实测账本（rate-ledger EMA=0）
// ② 目录缓存 free 字段。计划里的「内置快照」层刻意缺席（无证据不预编——
// 没有经核实的免费模型名单，编一个比缺一层更糟）。
//
// 与 send() 的接线用**源码自证**锁（防「模块写好、无调用方」——本仓
// qoder-telemetry / admin-security-headers 的接线回归同一模式）。
//
// 运行：node --test test/unit/workbuddy-free-exempt.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-wb-free');
process.env.DUMATE_ADMIN_DATA = TMP;

const models = require('../../src/workbuddy/models');
const rateLedger = require('../../src/workbuddy/rate-ledger');

test('isFreeModel：目录层 free 字段判免费（rate===0）', () => {
  models._setCatalog('cn', [
    { id: 'free-a', free: true },
    { id: 'paid-a', free: false },
  ]);
  assert.strictEqual(models.isFreeModel('cn', 'free-a'), true);
  assert.strictEqual(models.isFreeModel('cn', 'paid-a'), false);
  // 区域分缓存：cn 的目录不含 global 视角（同 id 跨区不互认）
  assert.strictEqual(models.isFreeModel('global', 'free-a'), false);
});

test('isFreeModel：实测账本层（EMA=0）优先于目录', () => {
  rateLedger.recordRate('measured-free', 'cn', 0);
  rateLedger.recordRate('measured-paid', 'cn', 0.34);
  assert.strictEqual(models.isFreeModel('cn', 'measured-free'), true);
  assert.strictEqual(models.isFreeModel('cn', 'measured-paid'), false);
  // 实测优先：目录说 free 但实测有付费样本 → 不豁免（证据强者胜）
  assert.strictEqual(
    models.isFreeModel('cn', 'measured-paid', [{ id: 'measured-paid', free: true }]),
    false,
  );
});

test('isFreeModel：边界（auto 不豁免 / 前缀剥离 / 未知不猜）', () => {
  // 'auto' 档位实际模型由账号决定，免费性不可知——永远不豁免
  assert.strictEqual(models.isFreeModel('cn', 'auto'), false);
  // workbuddy/ 前缀剥离后仍可判
  assert.strictEqual(models.isFreeModel('cn', 'workbuddy/free-a'), true);
  // 判不出来 false（不豁免）——错放付费模型 = 等同今日行为，错豁免才绕护栏
  assert.strictEqual(models.isFreeModel('cn', 'no-such-model'), false);
  assert.strictEqual(models.isFreeModel('cn', ''), false);
});

test('接线自证：send() 的护栏两层都认 freeModel（防模块写好、无调用方）', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'workbuddy', 'index.js'), 'utf8',
  );
  // ① guard.threshold 快照过滤跳过免费模型
  assert.match(src, /const lowIds = \(opts\.probe \|\| freeModel\) \? null : lowCreditIdSet\(\)/,
    'guard.threshold 过滤必须带 freeModel 豁免');
  // ② pool creditFloor 经 pickCandidate 的 paid 标记豁免（两处调用都要带）
  const paidCalls = src.match(/pickCandidate\(CHANNEL, (?:sub|pool), \{ sessionKey, model, expiring: fefo, paid: !freeModel \}\)/g) || [];
  assert.strictEqual(paidCalls.length, 2, '分片与常规两处 pickCandidate 都要传 paid: !freeModel');
});
