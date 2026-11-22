// test/verify-qoder-credits.js - Qoder 逐请求积分归因（离线）
//
// 修的问题：Qoder 的积分确实被消耗了，但请求日志的「积分消耗明细」里
// 只有搭子的记录——因为 Qoder 的 usage.credits 从未落盘成逐请求归因
// （千问有 qwenwork-credits.jsonl、TRAE 有 traework-credits.jsonl，Qoder 没有）。
//
// 与另两条通道的关键差异：**Qoder 上游直给本条 credits**，所以不需要
// 「相邻两条的差值」——首条就有值，并发也不串账。
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..');
const credits = require(path.join(REPO, 'src/qoder/credits'));

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

// 用临时目录隔离，避免污染真实数据
const { tmpDir } = require('./helpers/tmpdir');
const tmp = tmpDir('qoder-credits');
process.env.DUMATE_ADMIN_DATA = tmp;

(async () => {
  console.log('\nQoder 积分归因（离线，临时数据目录）\n');

  console.log('— 落盘形状 —');
  const acct = { id: 7, nickname: '张三', uid: 'u7' };
  const e1 = credits.capture(acct, 0.0034, { reqId: 'r1', model: 'qfmodel', ms: 1200 });
  ok('测到 credits 就落一条，带 req_id / 账号 / 模型', () => {
    assert.ok(e1, '应返回落盘记录');
    assert.strictEqual(e1.req_id, 'r1');
    assert.strictEqual(e1.account, '张三');
    assert.strictEqual(e1.account_id, 7);
    assert.strictEqual(e1.model, 'qfmodel');
    assert.strictEqual(e1.credits, 0.0034);
  });
  ok('credits 为 null 时不落盘（不补 0）', () => {
    assert.strictEqual(credits.capture(acct, null, { reqId: 'r-null' }), null);
    const idx = credits.indexByReqId();
    assert.ok(!idx.has('r-null'), '没测到就不该有记录');
  });
  ok('非数值字符串不落盘（不把 "abc" 强转成 NaN 记 0）', () => {
    assert.strictEqual(credits.capture(acct, 'abc', { reqId: 'r-str' }), null);
    assert.strictEqual(credits.capture(acct, NaN, { reqId: 'r-nan' }), null);
    assert.ok(!credits.indexByReqId().has('r-str'));
  });

  credits.capture(acct, 0.0633, { reqId: 'r2', model: 'qfmodel' });
  credits.capture(acct, 1.23456789, { reqId: 'r3', model: 'kmodel_latest' });

  console.log('\n— 按 req_id 附到请求日志行 —');
  const rows = [
    { ts: 1, req_id: 'r1', channel: 'qoder' },
    { ts: 2, req_id: 'r2', channel: 'qoder' },
    { ts: 3, req_id: 'r3', channel: 'qoder' },
    { ts: 4, req_id: 'r4', channel: 'qoder' },   // 未结算
    { ts: 5, req_id: 'r5', channel: 'dumate' },  // 别的通道不受影响
  ];
  const out = credits.attachCosts(rows);
  ok('qoder 行附上了 qoder_cost 与 qoder_account', () => {
    assert.strictEqual(out[0].qoder_cost, 0.0034);
    assert.strictEqual(out[0].qoder_account, '张三');
    assert.strictEqual(out[1].qoder_cost, 0.0633);
  });
  ok('credits 聚合时保留 4 位小数（不传浮点噪声）', () => {
    assert.strictEqual(out[2].qoder_cost, 1.2346);
  });
  ok('未结算的行不补字段（界面显示 —）', () => {
    assert.strictEqual(out[3].qoder_cost, undefined);
  });
  ok('非 qoder 通道的行不被改动', () => {
    assert.strictEqual(out[4].qoder_cost, undefined);
    assert.strictEqual(out[4].req_id, 'r5');
  });

  console.log('\n— 与游标式归因的差别 —');
  ok('首条就有值（不需要相邻记录做差）', () => {
    const idx = credits.indexByReqId();
    assert.ok(idx.has('r1'), '第一条请求也该有归因');
  });
  ok('逐笔明细的 exact 恒为 true（上游直给，不受并发影响）', () => {
    const recs = credits.creditRecords(10);
    assert.ok(recs.length >= 3);
    assert.ok(recs.every((r) => r.exact === true), '不该标并发');
  });
  ok('明细按时间倒序', () => {
    const recs = credits.creditRecords(10);
    const ts = recs.map((r) => r.ts);
    assert.deepStrictEqual(ts, ts.slice().sort((a, b) => b - a));
  });

  console.log('\n— 换号重试记到实际成功的账号 —');
  const other = { id: 9, nickname: '李四', uid: 'u9' };
  credits.capture(other, 0.5, { reqId: 'r6', model: 'gfmodel' });
  const out2 = credits.attachCosts([{ ts: 9, req_id: 'r6', channel: 'qoder' }]);
  ok('归因带的账号是本次实际使用的那个', () => {
    assert.strictEqual(out2[0].qoder_account, '李四');
  });

  console.log('\n— 今日合计 —');
  const t = credits.todayUsage();
  ok('今日消耗是各条之和（不是累计值相减）', () => {
    // 1.8013 = r1 + r2 + r3 + r6（r-str 被挡掉，不进合计）
    const expect = Number((0.0034 + 0.0633 + 1.2346 + 0.5).toFixed(4));
    assert.strictEqual(t.cost, expect);
    assert.strictEqual(t.requests, 4);
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();
