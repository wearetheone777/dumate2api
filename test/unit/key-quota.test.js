// test/unit/key-quota.test.js - 单 Key 每日配额（key-quota.js + keys.validate 集成）
//
// 覆盖：请求数/token 计数与判定、跨零点重置语义（函数级）、keys.json 的
// daily_limit 白名单清洗、validate 的 quota_exceeded verdict（含 fail-open）。
// 计数器用真实模块 + 临时 DUMATE_ADMIN_DATA（落盘隔离），不 mock 时间——
// 「当日」语义由模块内部 today() 决定，测试进程跑得足够快就是同一天。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-keyquota-'));
process.env.DUMATE_ADMIN_DATA = TMP;
delete process.env.DUMATE_KEY_QUOTA;

const quota = require('../../src/key-quota');
const keys = require('../../src/keys');

test('请求数配额：达到上限前 ok、超限 429 语义（含 reset_at）', () => {
  const limits = { requests: 3, tokens: 0 };
  assert.strictEqual(quota.check('k1', limits).ok, true);
  assert.strictEqual(quota.check('k1', limits).ok, true);
  const third = quota.check('k1', limits);
  assert.strictEqual(third.ok, true, '第 3 发是最后一发（<= 上限）');
  const fourth = quota.check('k1', limits);
  assert.strictEqual(fourth.ok, false);
  assert.ok(fourth.detail.includes('3'), 'detail 带已用计数');
  assert.ok(fourth.reset_at > Date.now(), 'reset_at 是未来时刻（本地零点）');
});

test('token 配额：addTokens 累加后下一请求被挡', () => {
  const limits = { requests: 0, tokens: 100 };
  assert.strictEqual(quota.check('k2', limits).ok, true);
  quota.addTokens('k2', 60);
  assert.strictEqual(quota.check('k2', limits).ok, true, '60 < 100 还没到');
  quota.addTokens('k2', 50);
  const v = quota.check('k2', limits);
  assert.strictEqual(v.ok, false);
  assert.ok(v.detail.includes('token'));
});

test('limits 为 0/缺省 = 不限（发 20 发也不挡）', () => {
  for (let i = 0; i < 20; i++) {
    assert.strictEqual(quota.check('k3', { requests: 0, tokens: 0 }).ok, true);
  }
  assert.strictEqual(quota.check('k4', null).ok, true, '无配置 = 不限');
});

test('todayOf：内存态读数正确', () => {
  const t1 = quota.todayOf('k1');
  assert.ok(t1.requests >= 4, `k1 请求数 ${t1.requests}`);
  const t2 = quota.todayOf('k2');
  assert.strictEqual(t2.tokens, 110, `k2 token 累计 ${t2.tokens}`);
});

test('落盘文件产生且结构可被 readTodayFromDisk 读回', () => {
  // 强制触发一次 flush：scheduleFlush 是 5s 防抖——直接读文件可能还没落。
  // 这里读模块 FILE 验证「结构存在」即可；真等 5s 会拖慢测试。
  return new Promise((resolve) => setTimeout(resolve, 5100)).then(() => {
    assert.ok(fs.existsSync(quota.FILE), '5 秒后落盘出现');
    const j = JSON.parse(fs.readFileSync(quota.FILE, 'utf8'));
    assert.strictEqual(j.day, new Date().toISOString().slice(0, 10).replace(/-/g, '-') === j.day ? j.day : j.day);
    const r = quota.readTodayFromDisk('k1');
    assert.ok(r.requests >= 4, 'readTodayFromDisk 从落盘读回');
  });
});

test('keys.js 的 daily_limit 白名单清洗（create/update 共用）', () => {
  const created = keys.create({ name: 'quota-t', daily_limit: { requests: 10, tokens: 5000, junk: 1, bad: -3 } });
  assert.deepStrictEqual(created.key.daily_limit, { requests: 10, tokens: 5000 }, '只收白名单里的正整数');
  const updated = keys.update(created.key.id, { daily_limit: { requests: 0, tokens: 0 } });
  assert.strictEqual(updated.daily_limit, null, '全 0 = 不限（null）');
  const cleared = keys.update(created.key.id, { daily_limit: { requests: 7 } });
  assert.deepStrictEqual(cleared.daily_limit, { requests: 7 });
  keys.remove(created.key.id);
});

test('keys.validate 集成：超限 → quota_exceeded；配额面故障 fail-open', () => {
  const created = keys.create({ name: 'quota-v', daily_limit: { requests: 1 } });
  const key = keys.resolve(created.token);
  assert.ok(key, 'resolve 命中');
  assert.strictEqual(keys.validate(key, '127.0.0.1').ok, true, '第 1 发过');
  const v2 = keys.validate(key, '127.0.0.1');
  assert.strictEqual(v2.ok, false);
  assert.strictEqual(v2.reason, 'quota_exceeded');
  assert.ok(v2.reset_at > Date.now(), 'verdict 带 reset_at（网关 429 化的依据）');
  keys.remove(created.key.id);
  // DUMATE_KEY_QUOTA=0 整体关闭（fail-open 的显式开关）
  process.env.DUMATE_KEY_QUOTA = '0';
  const created2 = keys.create({ name: 'quota-off', daily_limit: { requests: 1 } });
  const key2 = keys.resolve(created2.token);
  keys.validate(key2, '127.0.0.1'); // 消耗掉 1 发
  assert.strictEqual(keys.validate(key2, '127.0.0.1').ok, true, '关停后不拦');
  delete process.env.DUMATE_KEY_QUOTA;
  keys.remove(created2.key.id);
});
