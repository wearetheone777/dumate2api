// test/unit/session-key-system.test.js - 会话粘性键必须含 system（调研 P2-11）
//
// 真实症状：两个项目共用一句「继续」开场，system 不同，却撞同一个粘性键——
// 结果两个项目的长会话被绑到同一个账号上，前一秒还在 A 项目上下文里，后一秒
// 被塞进 B 项目的前缀缓存：命中率与上下文恢复成本双双恶化，而日志上什么都看不出来。
//
// 本文件锁四件事：
//   1. system 不同 → 键不同（这就是本项）
//   2. 同一会话稳定：system 与首条 user 不变时，后面追加多少轮都不换键
//   3. 两种 system 形状（顶层 / messages 里的 role=system / parts 数组）等价——
//      否则同一段话经不同协议进来会分裂成两个键
//   4. 键只依赖「首条 user + system 全文」；system 尾部不同必须被认成不同
//      （项目约定常追加在尾部，截断会把改过的 system 认成同一个）
//
// 运行：node --test test/unit/session-key-system.test.js
const assert = require('assert');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-sesskey-'));
process.env.DUMATE_ADMIN_DATA = TMP;
process.env.DUMATE_POOL_STATE = path.join(TMP, 'pool-state.json');

const channelPool = require('../../src/channel-pool');
const { pool } = require('../../src/pool');

const convo = (system, turns = 1) => {
  const messages = [{ role: 'user', content: '继续' }];
  for (let i = 1; i < turns; i++) {
    messages.push({ role: 'assistant', content: `第 ${i} 轮回复` });
    messages.push({ role: 'user', content: `继续 ${i}` });
  }
  return system === undefined ? { messages } : { ...(system == null ? {} : { system }), messages };
};

test('不同 system + 同一句「继续」→ 不同键（本项要修的症状）', () => {
  const a = channelPool.sessionKeyOf(convo('你是 A 项目助手'));
  const b = channelPool.sessionKeyOf(convo('你是 B 项目助手'));
  assert.ok(a.startsWith('m:'));
  assert.notStrictEqual(a, b, '两个项目的「继续」不能共用一个粘性键');
});

test('同一会话稳定：同 system 同首条 user，第 2 轮起键恒定（P1-8 修订口径）', () => {
  // P1-8（hub #839）修订了 P2-11 的旧不变量「追加多少轮都不换键」：
  // 第 2 轮起键含首条 assistant——同开场白的并发会话从第 2 轮分叉各走各号。
  // 会话连续性改由 prebind 保障（旧键绑定迁给新键，sticky-key-assistant.test.js
  // 的端到端用例锁）；本测试锁的是**第 2 轮起键稳定**（同首条 assistant）。
  const k1 = channelPool.sessionKeyOf(convo('共同 system', 1));   // 第 1 轮：无 assistant
  const k5 = channelPool.sessionKeyOf(convo('共同 system', 5));
  const k20 = channelPool.sessionKeyOf(convo('共同 system', 20));
  assert.strictEqual(k5, k20, '第 2 轮起（首条 assistant 相同）键恒定');
  assert.notStrictEqual(k1, k5, '第 1 轮与第 2 轮键不同（P1-8 的分叉点）——连续性由 prebind 兜住');
});

test('system 三种形状等价：顶层字符串 / parts 数组 / messages 里的 role=system', () => {
  const asString = channelPool.sessionKeyOf(convo('同一段话'));
  // 同一段话被拆成两个 text part：拼接后必须等于整串（拼接不带换行，见 textOf 注释）
  const asPartsTop = channelPool.sessionKeyOf({ system: [{ type: 'text', text: '同一段' }, { type: 'text', text: '话' }], messages: [{ role: 'user', content: '继续' }] });
  const asMessage = channelPool.sessionKeyOf({ messages: [{ role: 'system', content: '同一段话' }, { role: 'user', content: '继续' }] });
  assert.strictEqual(asString, asPartsTop, 'parts 数组与字符串是同一段话');
  assert.strictEqual(asString, asMessage, 'Anthropic 顶层与 OpenAI messages 里的 system 必须同键');
});

test('没有 system 也能出键（不是空串），且与「有 system」不同', () => {
  const none = channelPool.sessionKeyOf(convo(undefined));
  const withSys = channelPool.sessionKeyOf(convo('有 system'));
  assert.ok(none.startsWith('m:'));
  assert.notStrictEqual(none, withSys);
});

test('system 尾部不同必须被认成不同（全文哈希，不截断）', () => {
  const long = 'A'.repeat(5000);
  const k1 = channelPool.sessionKeyOf(convo(`${long}项目约定：只改 docs`));
  const k2 = channelPool.sessionKeyOf(convo(`${long}项目约定：只改 src`));
  assert.notStrictEqual(k1, k2, '差异在尾部也必须区分——截断会把改过的 system 认成同一个');
});

test('显式 sessionKey 优先（k: 前缀原样），不受 system 影响', () => {
  const k1 = channelPool.sessionKeyOf(convo('随便'), { sessionKey: 'case-a' });
  const k2 = channelPool.sessionKeyOf(convo('别的'), { sessionKey: 'case-a' });
  assert.strictEqual(k1, 'k:case-a');
  assert.strictEqual(k1, k2);
});

test('取不到首条 user 时不粘（空串），不编一个键出来', () => {
  assert.strictEqual(channelPool.sessionKeyOf({ messages: [] }), '');
  assert.strictEqual(channelPool.sessionKeyOf({ messages: [{ role: 'assistant', content: 'x' }] }), '');
  assert.strictEqual(channelPool.sessionKeyOf({ messages: [{ role: 'user', content: '   ' }] }), '');
  assert.strictEqual(channelPool.sessionKeyOf(null), '');
});

test('端到端：A 项目的长会话粘在同一个号上，B 项目不会串进来', () => {
  const acc = (id) => ({ id, uid: `uid-${id}`, nickname: `号${id}`, region: 'cn', enabled: true });
  const accounts = [acc(7001), acc(7002)];
  for (const a of accounts) pool.revive(`qoder:${a.id}`);

  const keyA = channelPool.sessionKeyOf(convo('你是 A 项目助手'));
  const keyB = channelPool.sessionKeyOf(convo('你是 B 项目助手'));
  assert.notStrictEqual(keyA, keyB);

  // A 项目第一轮：随便落到哪个号，记下来
  const s1 = channelPool.pickCandidate('qoder', accounts, { model: 'gfmodel', sessionKey: keyA });
  assert.ok(s1, 'A 项目应选到号');
  channelPool.release(s1.uid);
  // A 项目第二轮：必须还是同一个号（粘性生效）
  const s2 = channelPool.pickCandidate('qoder', accounts, { model: 'gfmodel', sessionKey: keyA });
  assert.strictEqual(s2.uid, s1.uid, '同一会话第二轮必须粘回同一个号');
  channelPool.release(s2.uid);

  // B 项目：键不同 → 不该被 A 的绑定抢走（池里另一个号就是它的）
  const s3 = channelPool.pickCandidate('qoder', accounts, { model: 'gfmodel', sessionKey: keyB });
  assert.ok(s3);
  assert.notStrictEqual(s3.uid, s1.uid, 'B 项目不该复用 A 项目的粘性账号');
  channelPool.release(s3.uid);

  channelPool._stickyClear();
  for (const a of accounts) pool.revive(`qoder:${a.id}`);
});

test('sessionKeyFor：算键 + 通知调用方（埋点单一入口），回调抛错不影响返回', () => {
  const p1 = convo('系统 A');
  const seen = [];
  const k1 = channelPool.sessionKeyFor(p1, { onSessionKey: (k) => seen.push(k) });
  assert.strictEqual(k1, channelPool.sessionKeyOf(p1), '键本身不变');
  assert.deepStrictEqual(seen, [k1], '回调要拿到同一个键');
  // 回调抛错：键照常返回（埋点绝不能影响选号）
  const k2 = channelPool.sessionKeyFor(p1, { onSessionKey: () => { throw new Error('boom'); } });
  assert.strictEqual(k2, k1);
  // 没有回调：照常出键
  assert.strictEqual(channelPool.sessionKeyFor(p1, {}), k1);
  // 取不到键时**不该**回调（空键进日志等于给每行都写一个空值）
  const none = [];
  assert.strictEqual(channelPool.sessionKeyFor({ messages: [] }, { onSessionKey: (k) => none.push(k) }), '');
  assert.deepStrictEqual(none, []);
});
