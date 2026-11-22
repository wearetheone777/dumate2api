// test/unit/workbuddy-dump.test.js - 11-128 风控取证开关（P1-5）
//
// 出处：docs/WORKBUDDY-FUSION.md P1-5（hub `WB_DUMP_11_128`）。hub 2026-11-06
// 停更，这个排障能力只能自己养；11-128 是 Claude Code 类请求最常见的拒绝码。
//
// 锁住四条纪律：
//   1. 默认关闭（不配 env 一个字节都不写）
//   2. 摘要档**不含提示词明文**（要能长期开着）；full 档才有原文且 token 脱敏
//   3. 码值匹配带负向数字断言（111280 不被 11128 吃掉）
//   4. 写失败/目录不可写不影响请求（取证是观测，不该拖垮热路径）
//
// 运行：node --test test/unit/workbuddy-dump.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-wb-dump');
process.env.DUMATE_ADMIN_DATA = TMP;
delete process.env.DUMATE_WORKBUDDY_DUMP_11_128;
delete process.env.DUMATE_WORKBUDDY_DUMP_CODES;

const dump = require('../../src/workbuddy/dump');

const INFO = {
  region: 'cn',
  model: 'glm-5.3',
  status: 400,
  code: '11128',
  headers: {
    Authorization: 'Bearer abcdefghijklmnop',
    'X-User-Id': 'u-1',
    'X-IDE-Version': '5.5.6',
    'X-Conversation-ID': 'conv-1',
    'User-Agent': 'WorkBuddy/5.5.6 WorkBuddy/5.5.6',
    'Content-Type': 'application/json',
    Cookie: 'sid=secret',
  },
  bodyText: JSON.stringify({
    model: 'glm-5.3',
    stream: true,
    conversation_id: 'conv-1',
    max_tokens: 65536,
    messages: [
      { role: 'system', content: 'You are Claude Code, Anthropic\'s official CLI for Claude.' },
      { role: 'user', content: '我的提示词明文：帮我写一个函数' },
    ],
  }),
};

function cleanDir() {
  try { fs.rmSync(dump.dumpDir(), { recursive: true, force: true }); } catch (e) { /* 没有更正常 */ }
}

test('mode：未设 = off；1/true/on = summary；full = full；其它 = off', () => {
  assert.strictEqual(dump.mode(), 'off');
  for (const v of ['1', 'true', 'YES', ' on ', 'summary']) {
    process.env.DUMATE_WORKBUDDY_DUMP_11_128 = v;
    assert.strictEqual(dump.mode(), 'summary', `env=${v}`);
  }
  process.env.DUMATE_WORKBUDDY_DUMP_11_128 = 'full';
  assert.strictEqual(dump.mode(), 'full');
  process.env.DUMATE_WORKBUDDY_DUMP_11_128 = '0';
  assert.strictEqual(dump.mode(), 'off');
  delete process.env.DUMATE_WORKBUDDY_DUMP_11_128;
});

test('matchesCode：默认认 11-128 / 11128，数字带负向断言', () => {
  assert.strictEqual(dump.matchesCode('{"code":11128}'), '11128');
  assert.strictEqual(dump.matchesCode('{"code":"11128"}'), '11128');
  assert.strictEqual(dump.matchesCode('Illegal API invocation from an unapproved channel (11-128)'), '11-128');
  assert.strictEqual(dump.matchesCode('{"code":111280}'), null, '111280 不该被 11128 吃掉');
  assert.strictEqual(dump.matchesCode('{"code":402}'), null);
  assert.strictEqual(dump.matchesCode(''), null);
});

test('matchesCode：env 可扩任意错误码', () => {
  process.env.DUMATE_WORKBUDDY_DUMP_CODES = '6004, 12153';
  assert.deepStrictEqual(dump.codes(), ['6004', '12153']);
  assert.strictEqual(dump.matchesCode('{"code":6004}'), '6004');
  assert.strictEqual(dump.matchesCode('{"code":12153}'), '12153');
  delete process.env.DUMATE_WORKBUDDY_DUMP_CODES;
  assert.deepStrictEqual(dump.codes(), dump.DEFAULT_CODES);
});

test('关闭时 dump 一个字节都不写', () => {
  cleanDir();
  assert.strictEqual(dump.dump(INFO), null);
  assert.deepStrictEqual(dump.list(), []);
});

test('摘要档：写文件但**不含提示词明文**，含结构指纹与身份头清单', () => {
  cleanDir();
  process.env.DUMATE_WORKBUDDY_DUMP_11_128 = '1';
  const p = dump.dump(INFO);
  assert.ok(p && fs.existsSync(p), '应落盘');
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(!raw.includes('帮我写一个函数'), '摘要档绝不能含用户提示词');
  assert.ok(!raw.includes('Anthropic'), '摘要档也不含 system 明文');
  assert.ok(!raw.includes('sid=secret'), 'Cookie 值不外泄');
  assert.ok(!/Bearer\s+abcdefghij/.test(raw), 'token 已脱敏');

  const row = JSON.parse(raw);
  assert.strictEqual(row.level, 'summary');
  assert.strictEqual(row.code, '11128');
  assert.strictEqual(row.bodyBytes > 0, true);
  assert.strictEqual(row.shape.stream, true);
  assert.strictEqual(row.shape.roles.length, 2);
  assert.strictEqual(row.shape.hasConversationId, true);
  assert.strictEqual(row.shape.hasTools, 0);
  assert.strictEqual(row.shape.maxTokens, 65536);
  // 身份头清单（11-128 判的就是这些）
  assert.ok(row.headers.identity.includes('X-User-Id'));
  assert.ok(row.headers.identity.includes('X-IDE-Version'));
  assert.ok(!row.headers.identity.includes('Authorization'), 'Authorization 不进身份头清单（值敏感）');
  assert.ok(/不要先换号/.test(row.hint), '排障纪律要写进文件，避免后人先换号');
  cleanDir();
  delete process.env.DUMATE_WORKBUDDY_DUMP_11_128;
});

test('full 档：额外写原文（token 脱敏），文件名带 -full', () => {
  cleanDir();
  process.env.DUMATE_WORKBUDDY_DUMP_11_128 = 'full';
  const p = dump.dump(INFO);
  assert.ok(p && /-full\.json$/.test(p), `full 档文件名应带 -full，实际 ${p}`);
  const row = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(row.level, 'full');
  assert.ok(row.bodyText.includes('帮我写一个函数'), 'full 档含原文');
  assert.ok(!/Bearer\s+abcdefghij/.test(row.bodyText), '原文里的 token 也要脱敏');
  assert.ok(/删除/.test(row.note), '要提示排查完删除');
  cleanDir();
  delete process.env.DUMATE_WORKBUDDY_DUMP_11_128;
});

test('list：新的在前，能区分 full 档（同毫秒两次写不能互相覆盖）', () => {
  cleanDir();
  process.env.DUMATE_WORKBUDDY_DUMP_11_128 = '1';
  const p1 = dump.dump({ ...INFO, code: '11128' });
  process.env.DUMATE_WORKBUDDY_DUMP_11_128 = 'full';
  const p2 = dump.dump({ ...INFO, code: '11-128' });
  const rows = dump.list();
  assert.strictEqual(rows.length, 2, '文件名必须唯一：同毫秒两次命中各留一份（+ 序号+随机后缀）');
  assert.strictEqual(rows[0].name, path.basename(p2), '最新的一份排最前');
  assert.strictEqual(rows[0].full, true);
  assert.strictEqual(rows[1].full, false);
  assert.ok(rows.every((r) => r.bytes > 0));
  assert.ok(p1);
  cleanDir();
  delete process.env.DUMATE_WORKBUDDY_DUMP_11_128;
});

test('同毫秒连写 20 份全部保留（多账号并发撞 11-128 时不丢样本）', () => {
  // 真实场景：取证档长期开着，多个账号在同一瞬间被判 11-128。原来文件名只到
  // 毫秒，同毫秒 N 次命中会静默覆盖成 1 份——排障时少掉的正是关键样本。
  cleanDir();
  process.env.DUMATE_WORKBUDDY_DUMP_11_128 = '1';
  const paths = [];
  for (let i = 0; i < 20; i++) paths.push(dump.dump({ ...INFO, code: '11128' }));
  assert.strictEqual(new Set(paths).size, 20, '每份路径唯一');
  assert.strictEqual(dump.list(100).length, 20, '磁盘上一份都不能少');
  assert.ok(paths.every((p) => p && fs.existsSync(p)));
  cleanDir();
  delete process.env.DUMATE_WORKBUDDY_DUMP_11_128;
});

test('list 按写入顺序倒序（同毫秒内也稳定，靠补零序号）', () => {
  cleanDir();
  process.env.DUMATE_WORKBUDDY_DUMP_11_128 = '1';
  const p1 = dump.dump({ ...INFO, code: '11128' });
  const p2 = dump.dump({ ...INFO, code: '11128' });
  const p3 = dump.dump({ ...INFO, code: '11128' });
  const names = dump.list(10).map((r) => r.name);
  assert.deepStrictEqual(names, [p3, p2, p1].map((p) => path.basename(p)),
    '同毫秒内也要按写入序倒排，否则「最新一份」说不清');
  cleanDir();
  delete process.env.DUMATE_WORKBUDDY_DUMP_11_128;
});
test('落盘不可写时 dump 返回 null 而不是抛（取证不拖垮请求）', () => {
  const good = process.env.DUMATE_ADMIN_DATA;
  process.env.DUMATE_WORKBUDDY_DUMP_11_128 = '1';
  try {
    const blocker = path.join(TMP, 'blocker-file');
    fs.writeFileSync(blocker, 'x');
    process.env.DUMATE_ADMIN_DATA = blocker;   // 目录位置是个文件 → mkdir 必失败
    assert.strictEqual(dump.dump(INFO), null);
    assert.strictEqual(dump.mode(), 'summary', '档位读取本身不受影响');
  } finally {
    process.env.DUMATE_ADMIN_DATA = good;
    delete process.env.DUMATE_WORKBUDDY_DUMP_11_128;
  }
});

test('summaryOf：非 JSON body 与缺失字段都不崩', () => {
  const row = dump.summaryOf({ region: 'global', status: 400, code: '11-128', headers: {}, bodyText: '<html>401</html>' });
  assert.strictEqual(row.shape, null);
  assert.strictEqual(row.bodyBytes > 0, true);
  assert.deepStrictEqual(row.headers.names, []);
  const row2 = dump.summaryOf({});
  assert.strictEqual(row2.status, 0);
  assert.strictEqual(row2.region, '');
});
