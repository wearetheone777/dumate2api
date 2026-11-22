// test/unit/qoder-claim-verify.test.js - 签到归属只读核验（P0-2）
//
// 调研出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P0-2 + 「协议层新情报汇总」。
// 核心情报（workbuddy2api 面板 2026-11-04 真机实测更正版）：每日 100 Credits
// **按账号各发一份**，只有服务端判定「同一个人」时才只发一份（后领的被拒
// `SAME_PERSON_ALREADY_CLAIMED`）。设备指纹与 agentAccountScope 均不参与判定。
//
// 为什么必须核验：grants 账本以 grantId 为幂等键，但「领过了」与「真领到了」
// 是两回事——被判同人的号没有积分进账，账本照记领取额就是假数据，
// FEFO 推算剩余跟着错（把两个号都当成有积分）。
//
// 三条不变量（放宽任何一条都会产生假数据或越界请求）：
//   1. 核验端点是 **GET**（只读），绝不触发领取；cid 只取本账号自己列表里的
//   2. 三态严格区分：claimed / same_person / **unverified（不猜不假报）**
//   3. 核验失败不改变签到结论——签到成功仍然是成功，只是标「未核实」
//
// 手法：拦截 https.request 按剧本喂响应（参照 verify-qoder-read-idle.js），
// 不需要账号与网络。
// 运行：node --test test/unit/qoder-claim-verify.test.js
const test = require('node:test');
const assert = require('node:assert');
const https = require('https');
const { EventEmitter } = require('events');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-qoder-claimverify');
process.env.DUMATE_ADMIN_DATA = TMP;

const grants = require('../../src/qoder/grants');
const session = require('../../src/qoder/session');

// ---- https 打桩：按剧本返回 {status, body} ----
let scenarios = [];   // 队列，每次请求消费一个
let captured = [];    // 记录 {method, path, headers}

const origRequest = https.request;
https.request = function mocked(opts, cb) {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => {};
  req.destroy = () => {};
  const rec = { method: opts.method, path: opts.path, headers: opts.headers || {} };
  captured.push(rec);
  const sc = scenarios.shift() || { status: 500, body: '{}' };
  setImmediate(() => {
    const res = new EventEmitter();
    res.statusCode = sc.status;
    res.headers = {};
    cb(res);
    setImmediate(() => {
      res.emit('data', Buffer.from(typeof sc.body === 'string' ? sc.body : JSON.stringify(sc.body), 'utf8'));
      res.emit('end');
    });
  });
  return req;
};

test.after(() => { https.request = origRequest; });

function reset() { scenarios = []; captured = []; }

// ---- 1. 纯函数三态 ----

test('classifyVerification：CLAIMED + grantId 一致 → claimed', () => {
  const c = grants.classifyVerification({ ok: true, status: 'CLAIMED', grantId: 'g-1' }, 'g-1');
  assert.strictEqual(c.verification, 'claimed');
  assert.strictEqual(c.verified, true);
  assert.strictEqual(c.samePerson, false);
  assert.strictEqual(c.verifyNote, '');
});

test('classifyVerification：BLOCKED + SAME_PERSON → same_person（点名额度进了别的号）', () => {
  const c = grants.classifyVerification({ ok: true, status: 'BLOCKED', samePerson: true }, 'g-1');
  assert.strictEqual(c.verification, 'same_person');
  assert.strictEqual(c.verified, false);
  assert.strictEqual(c.samePerson, true);
  assert.match(c.verifyNote, /同一人/);
});

test('classifyVerification：grantId 不一致 → unverified（不因为「状态是 CLAIMED」就认账）', () => {
  const c = grants.classifyVerification({ ok: true, status: 'CLAIMED', grantId: 'g-other' }, 'g-1');
  assert.strictEqual(c.verification, 'unverified');
  assert.strictEqual(c.verified, null);
  assert.match(c.verifyNote, /不一致/);
});

test('classifyVerification：核验没给 grantId → unverified（无法逐条比对）', () => {
  const c = grants.classifyVerification({ ok: true, status: 'CLAIMED', grantId: '' }, 'g-1');
  assert.strictEqual(c.verification, 'unverified');
  assert.strictEqual(c.verified, null);
  assert.match(c.verifyNote, /未返回 grantId/);
});

test('classifyVerification：请求失败 / 端点不可用 → unverified，且两者文案不同', () => {
  const a = grants.classifyVerification({ ok: false, error: 'HTTP 500' }, 'g-1');
  assert.strictEqual(a.verification, 'unverified');
  assert.match(a.verifyNote, /核验请求失败.*HTTP 500/);

  const b = grants.classifyVerification({ ok: false, unsupported: true, error: 'HTTP 404' }, 'g-1');
  assert.strictEqual(b.verification, 'unverified');
  assert.match(b.verifyNote, /端点不可用/);

  const c = grants.classifyVerification(null, 'g-1');
  assert.strictEqual(c.verification, 'unverified', 'null 也要给结论，不抛');
});

test('classifyVerification：BLOCKED 但没有同人标记 → unverified（不猜成同人）', () => {
  const c = grants.classifyVerification({ ok: true, status: 'BLOCKED' }, 'g-1');
  assert.strictEqual(c.verification, 'unverified');
  assert.strictEqual(c.samePerson, false, '没有 SAME_PERSON 证据就不能说「被别人领了」');
});

// ---- 2. 账本字段 ----

test('fromClaim：核验字段落账本，老行缺失按 unverified', () => {
  const e = grants.fromClaim({
    ok: true, grantId: 'g-9', grantedAt: new Date().toISOString(),
    validityMode: 'RELATIVE_DAYS', validityDays: 30, amount: 100,
    verification: 'same_person', verified: false, samePerson: true, verifyNote: '同人',
  }, { id: 5, nickname: '号5' }, Date.now());
  assert.strictEqual(e.verification, 'same_person');
  assert.strictEqual(e.verified, false);
  assert.strictEqual(e.samePerson, true);

  const plain = grants.fromClaim({
    ok: true, grantId: 'g-10', grantedAt: new Date().toISOString(), amount: 100,
  }, { id: 6 }, Date.now());
  assert.strictEqual(plain.verification, 'unverified', '没有核验结果 ≠ 已核验通过');
  assert.strictEqual(plain.verified, null, 'null 不是 false——「没查」与「查了没通过」不同');
  assert.strictEqual(plain.samePerson, false);
});

// ---- 3. verifyClaim 网络形状（只读、cid 来自本账号） ----

test('verifyClaim：发的是 GET，路径带 /reward，用 cosy-clienttype: 10', async () => {
  reset();
  scenarios.push({ status: 200, body: { status: 'CLAIMED', grantId: 'g-1' } });
  const r = await session.verifyClaim('dt-token', 'cn', 'camp-42');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'CLAIMED');
  assert.strictEqual(r.grantId, 'g-1');
  assert.strictEqual(r.campaignId, 'camp-42');
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].method, 'GET', '核验必须是 GET（只读）');
  assert.match(captured[0].path, /\/sash\/api\/v1\/me\/campaigns\/camp-42\/reward$/);
  assert.strictEqual(captured[0].headers['cosy-clienttype'], '10');
  assert.match(captured[0].headers.Authorization, /^Bearer dt-token$/);
});

test('verifyClaim：识别 SAME_PERSON_ALREADY_CLAIMED（结构化字段或文案任一处）', async () => {
  reset();
  scenarios.push({
    status: 200,
    body: { status: 'BLOCKED', code: 'SAME_PERSON_ALREADY_CLAIMED' },
  });
  const r = await session.verifyClaim('dt', 'cn', 'c1');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.samePerson, true);

  reset();
  scenarios.push({ status: 200, body: { status: 'BLOCKED', message: '额度已被同一个人领取' } });
  const r2 = await session.verifyClaim('dt', 'cn', 'c1');
  assert.strictEqual(r2.samePerson, true, '中文文案也要认');
});

test('verifyClaim：404/405 → unsupported（该上游版本没这个接口，如实说）', async () => {
  reset();
  scenarios.push({ status: 404, body: { message: 'not found' } });
  const r = await session.verifyClaim('dt', 'cn', 'c1');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.unsupported, true);
  assert.match(r.error, /404/);
});

test('verifyClaim：缺 campaignId 时直接拒绝，不打上游', async () => {
  reset();
  const r = await session.verifyClaim('dt', 'cn', '');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(captured.length, 0, '没有 cid 就不该发请求（绝不拿别人的活动 id 去探账）');
});

test('verifyClaim：只调一次 reward 端点，不调 claim（只读的硬约束）', async () => {
  reset();
  scenarios.push({ status: 200, body: { status: 'CLAIMED', grantId: 'g-1' } });
  await session.verifyClaim('dt', 'cn', 'c9');
  assert.strictEqual(captured.length, 1);
  assert.ok(!captured.some((c) => /\/claim$/.test(c.path)), '核验绝不能打到 /claim');
});

// ---- 4. 端到端：session.checkin 把核验结果透出并落账本 ----

test('checkin：领取后自动核验，三态落账本（claimed）', async () => {
  reset();
  const now = new Date().toISOString();
  // 顺序：quota(before) → campaigns → claim → reward → quota(after)
  scenarios.push({ status: 200, body: { addOnQuota: { remaining: 0, total: 0, used: 0 } } });
  scenarios.push({
    status: 200,
    body: { claimable: true, campaigns: [{ campaignId: 'c1', claimStatus: 'CLAIMABLE', campaignKey: 'daily', benefit: { amount: 100 } }] },
  });
  scenarios.push({
    status: 200,
    body: {
      status: 'CLAIMED', grantId: 'g-100', grantedAt: now,
      benefit: { amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 }, grantId: 'g-100', campaignKey: 'daily' },
    },
  });
  scenarios.push({ status: 200, body: { status: 'CLAIMED', grantId: 'g-100' } });
  scenarios.push({ status: 200, body: { addOnQuota: { remaining: 100, total: 100, used: 0 } } });

  const r = await session.checkin('dt', 'cn', { account: { id: 77, nickname: '号77', region: 'cn' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.claimed.length, 1);
  const one = r.claimed[0];
  assert.strictEqual(one.verification, 'claimed', '应透出三态');
  assert.strictEqual(one.verified, true);
  assert.strictEqual(one.samePerson, false);
  assert.strictEqual(r.gained, 100, '到账差值仍以上游余额为准');

  const row = grants.readAll().find((x) => x.grantId === 'g-100');
  assert.ok(row, '账本要落一条');
  assert.strictEqual(row.verification, 'claimed');
  assert.strictEqual(row.verified, true);
  assert.strictEqual(row.accountId, 77);
});

test('checkin：核验判同人时账本如实标 same_person（不算领取额）', async () => {
  reset();
  const now = new Date().toISOString();
  scenarios.push({ status: 200, body: { addOnQuota: { remaining: 0 } } });
  scenarios.push({
    status: 200,
    body: { claimable: true, campaigns: [{ campaignId: 'c2', claimStatus: 'CLAIMABLE', campaignKey: 'daily', benefit: { amount: 100 } }] },
  });
  scenarios.push({
    status: 200,
    body: {
      status: 'CLAIMED', grantId: 'g-200', grantedAt: now,
      benefit: { amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 }, grantId: 'g-200' },
    },
  });
  scenarios.push({ status: 200, body: { status: 'BLOCKED', code: 'SAME_PERSON_ALREADY_CLAIMED' } });
  scenarios.push({ status: 200, body: { addOnQuota: { remaining: 0 } } });

  const r = await session.checkin('dt', 'cn', { account: { id: 88, nickname: '号88', region: 'cn' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.claimed[0].verification, 'same_person');
  assert.strictEqual(r.claimed[0].samePerson, true);
  assert.strictEqual(r.gained, 0, '同一个人的额度已进别的号，本号确实没进账');

  const row = grants.readAll().find((x) => x.grantId === 'g-200');
  assert.strictEqual(row.verification, 'same_person');
  assert.strictEqual(row.verified, false);
  assert.match(row.verifyNote, /同一人/);
});

test('checkin：核验端点挂了不改变签到结论（标未核实，不假报）', async () => {
  reset();
  const now = new Date().toISOString();
  scenarios.push({ status: 200, body: { addOnQuota: { remaining: 0 } } });
  scenarios.push({
    status: 200,
    body: { claimable: true, campaigns: [{ campaignId: 'c3', claimStatus: 'CLAIMABLE', campaignKey: 'daily', benefit: { amount: 100 } }] },
  });
  scenarios.push({
    status: 200,
    body: { status: 'CLAIMED', grantId: 'g-300', grantedAt: now, benefit: { amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 } } },
  });
  scenarios.push({ status: 500, body: { message: 'internal' } });
  scenarios.push({ status: 200, body: { addOnQuota: { remaining: 100 } } });

  const r = await session.checkin('dt', 'cn', { account: { id: 99, nickname: '号99', region: 'cn' } });
  assert.strictEqual(r.ok, true, '核验失败不该让签到变成失败');
  assert.strictEqual(r.claimed[0].ok, true);
  assert.strictEqual(r.claimed[0].verification, 'unverified');
  assert.strictEqual(r.claimed[0].verified, null);
  assert.ok(r.claimed[0].verifyNote, '要给出为什么未核实');
  assert.strictEqual(r.gained, 100, '到账差值照旧按余额算');
});

test('checkin：领取被拒（SAME_PERSON）时带出 samePerson 标记而不是普通错误', async () => {
  reset();
  scenarios.push({ status: 200, body: { addOnQuota: { remaining: 0 } } });
  scenarios.push({
    status: 200,
    body: { claimable: true, campaigns: [{ campaignId: 'c4', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } }] },
  });
  scenarios.push({
    status: 403,
    body: { code: 'SAME_PERSON_ALREADY_CLAIMED', message: 'already claimed by the same person' },
  });
  scenarios.push({ status: 200, body: { addOnQuota: { remaining: 0 } } });

  const r = await session.checkin('dt', 'cn', { account: { id: 100, nickname: '号100', region: 'cn' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.claimed[0].ok, false);
  assert.strictEqual(r.claimed[0].samePerson, true, '领取环节也要认这个码');
  assert.strictEqual(r.claimed[0].status, 'BLOCKED');
});
