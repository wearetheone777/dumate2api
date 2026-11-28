// test/unit/sticky-key-assistant.test.js - 会话粘滞键补强（P1-8，hub v2.0.7 #839/#842）
//
// 两部分：
//   A. 键含首条 assistant（#839）：同开场白的并发会话从第 2 轮起分叉各走各号；
//      第 1 轮键与 P2-11 旧口径**逐字节一致**；第 2 轮 prebind 迁移第 1 轮的
//      绑定（会话跨键变更不换号）。
//   B. 单发请求分片亲和（#842，DUMATE_WB_MSGSTAT_SHARDS 默认关）：内容指纹 +
//      日盐 → 固定 ≤N 个账号，跨重启稳定（粘滞表在内存，重启即丢——分片
//      是从请求内容重算的，不丢）。
//
// 运行：node --test test/unit/sticky-key-assistant.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { tmpDir } = require('../helpers/tmpdir');
process.env.DUMATE_ADMIN_DATA = tmpDir('dumate-sticky-asst');
process.env.DUMATE_POOL_STATE = tmpDir('dumate-sticky-asst-state') + '/pool-state.json';

const channelPool = require('../../src/channel-pool');
const { pool } = require('../../src/pool');
const wbIndex = require('../../src/workbuddy/index');

// ---------- 工具 ----------

/** P2-11 旧口径的手工构造（回归锚：第 1 轮键必须与它逐字节一致） */
function legacyKey(sys, user) {
  const d = crypto.createHash('sha1').update(sys).update('\u0000').update(user.slice(0, 2048)).digest('hex').slice(0, 20);
  return `m:${d}`;
}

const SYS = '你是项目助手，遵循项目约定。'.repeat(5);
const USER = '帮我看一下这个报错栈';

function round1Payload() {
  return { messages: [{ role: 'system', content: SYS }, { role: 'user', content: USER }] };
}
function round2Payload(asstReply) {
  const p = round1Payload();
  p.messages.push({ role: 'assistant', content: asstReply });
  p.messages.push({ role: 'user', content: '还是不行，换了个姿势又报了' });
  return p;
}

// ---------- A. 键含首条 assistant ----------

test('P1-8：第 1 轮键（无 assistant）与 P2-11 旧口径逐字节一致', () => {
  const k = channelPool.sessionKeyOf(round1Payload(), {});
  assert.equal(k, legacyKey(SYS, USER), '旧口径回归锚——改键形状必须先过这条');
});

test('P1-8：第 2 轮键（含 assistant）与第 1 轮分叉，形状 = sha1(sys·user·asst)', () => {
  const k1 = channelPool.sessionKeyOf(round1Payload(), {});
  const k2 = channelPool.sessionKeyOf(round2Payload('第一次的回答'), {});
  assert.notEqual(k1, k2, 'assistant 进键：同开场白从第 2 轮分叉');
  const d = crypto.createHash('sha1')
    .update(SYS).update('\u0000').update(USER.slice(0, 2048))
    .update('\u0000').update('第一次的回答'.slice(0, 2048))
    .digest('hex').slice(0, 20);
  assert.equal(k2, `m:${d}`);
  // 稳定性：同一 payload 再算一遍不变
  assert.equal(channelPool.sessionKeyOf(round2Payload('第一次的回答'), {}), k2);
});

test('P1-8：同开场白、不同 assistant 回复 → 不同键（并发会话各走各号）', () => {
  const a = channelPool.sessionKeyOf(round2Payload('会话甲的回答'), {});
  const b = channelPool.sessionKeyOf(round2Payload('会话乙的回答'), {});
  assert.notEqual(a, b);
});

test('P1-8：显式 opts.sessionKey 不参与迁移（调用方全权管理）', () => {
  const k = channelPool.sessionKeyOf(round2Payload('x'), { sessionKey: 'explicit-1' });
  assert.equal(k, 'k:explicit-1');
});

test('P1-8：prebind 端到端——第 2 轮的键继承第 1 轮绑定的账号', async () => {
  pool.revive();
  channelPool._stickyClear();
  for (const id of [1, 2, 3]) pool.noteSuccess(`workbuddy:${id}`);
  const accounts = [{ id: 1 }, { id: 2 }, { id: 3 }];

  // 第 1 轮：粘滞表空 → 池轮询选中某号并 bind(r1, uid)
  let reported1 = '';
  const r1 = channelPool.sessionKeyFor(round1Payload(), { onSessionKey: (k) => { reported1 = k; } });
  assert.equal(reported1, r1, '键产生与上报绑定在同一函数');
  const sel1 = channelPool.pickCandidate('workbuddy', accounts, { sessionKey: r1 });
  assert.ok(sel1, '第 1 轮应选中账号');
  channelPool.release(sel1.uid);

  // 第 2 轮：键变更（assistant 进键）→ 迁移后仍选中同一账号
  let reported2 = '';
  const r2 = channelPool.sessionKeyFor(round2Payload('模型第 1 轮的回答'), { onSessionKey: (k) => { reported2 = k; } });
  assert.notEqual(r1, r2);
  assert.equal(reported2, r2);
  const sel2 = channelPool.pickCandidate('workbuddy', accounts, { sessionKey: r2 });
  assert.ok(sel2, '第 2 轮应选中账号');
  assert.equal(sel2.uid, sel1.uid, 'prebind：键变了、号不变（前缀缓存不断）');
  channelPool.release(sel2.uid);

  // 幂等：重复迁移不产生副作用（再算再选仍是同一号）
  channelPool.sessionKeyFor(round2Payload('模型第 1 轮的回答'), {});
  const sel3 = channelPool.pickCandidate('workbuddy', accounts, { sessionKey: r2 });
  assert.equal(sel3.uid, sel1.uid);
  channelPool.release(sel3.uid);
});

test('P1-8：旧键没有绑定时第 2 轮正常走池轮询（迁移是无害的尽力而为）', async () => {
  pool.revive();
  channelPool._stickyClear();
  for (const id of [1, 2]) pool.noteSuccess(`workbuddy:${id}`);
  const accounts = [{ id: 1 }, { id: 2 }];
  // 直接用第 2 轮 payload（没有第 1 轮的绑定）：新键无迁移来源 → 池轮询
  const r2 = channelPool.sessionKeyFor(round2Payload('凭空开始的第 2 轮'), {});
  const sel = channelPool.pickCandidate('workbuddy', accounts, { sessionKey: r2 });
  assert.ok(sel, '没有旧绑定也要能选到号');
  channelPool.release(sel.uid);
});

// ---------- B. 单发请求分片亲和 ----------

test('P1-8 分片：默认关（env 未设）→ null', () => {
  delete process.env.DUMATE_WB_MSGSTAT_SHARDS;
  const usable = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.equal(wbIndex.msgstatShardIds(usable, { sessionKey: 'k', model: 'm', payload: round1Payload() }), null);
});

test('P1-8 分片：非单发请求不分片（多轮有粘滞键兜着）', () => {
  process.env.DUMATE_WB_MSGSTAT_SHARDS = '2';
  const usable = [{ id: 1 }, { id: 2 }, { id: 3 }];
  try {
    assert.equal(wbIndex.msgstatShardIds(usable, { sessionKey: 'k', model: 'm', payload: round2Payload('x') }), null);
    assert.equal(wbIndex.isSingleShot(round1Payload()), true);
    assert.equal(wbIndex.isSingleShot(round2Payload('x')), false);
  } finally {
    delete process.env.DUMATE_WB_MSGSTAT_SHARDS;
  }
});

test('P1-8 分片：单发 + 开启 → 稳定的 ≤N 个账号 id（内容指纹 + 日盐）', () => {
  process.env.DUMATE_WB_MSGSTAT_SHARDS = '2';
  const usable = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  try {
    const s1 = wbIndex.msgstatShardIds(usable, { sessionKey: 'm:abc', model: 'glm-5.3', payload: round1Payload() });
    assert.ok(s1 && s1.size >= 1 && s1.size <= 2, `分片集应 1~2 个，实际 ${s1 && s1.size}`);
    for (const id of s1) assert.ok(usable.some((a) => String(a.id) === id), '分片集必须是候选的子集');
    const s2 = wbIndex.msgstatShardIds(usable, { sessionKey: 'm:abc', model: 'glm-5.3', payload: round1Payload() });
    assert.deepEqual([...s1].sort(), [...s2].sort(), '同一内容指纹跨调用稳定（跨重启也稳定：哈希来自请求内容）');
  } finally {
    delete process.env.DUMATE_WB_MSGSTAT_SHARDS;
  }
});

test('P1-8 分片：N ≥ 候选数时全量都是亲和集（退化安全）', () => {
  process.env.DUMATE_WB_MSGSTAT_SHARDS = '10';
  const usable = [{ id: 1 }, { id: 2 }];
  try {
    const s = wbIndex.msgstatShardIds(usable, { sessionKey: 'm:x', model: 'm', payload: round1Payload() });
    assert.equal(s.size, 2);
  } finally {
    delete process.env.DUMATE_WB_MSGSTAT_SHARDS;
  }
});

test('P1-8 分片：日盐按北京时间日轮换（跨日映射换新，账号间摊匀消耗）', () => {
  // 2026-11-28 23:00 UTC+8 与次日 01:00 UTC+8（前者的 UTC 表示 +8h 后跨日）
  const t1 = Date.UTC(2026, 10, 28, 15, 0, 0);   // UTC 15:00 = 北京 23:00
  const t2 = Date.UTC(2026, 10, 28, 17, 0, 0);   // UTC 17:00 = 北京次日 01:00
  const s1 = wbIndex.msgstatDaySalt(t1);
  const s2 = wbIndex.msgstatDaySalt(t2);
  assert.equal(s1, '20261128');
  assert.equal(s2, '20261129');
  assert.notEqual(s1, s2);
});
