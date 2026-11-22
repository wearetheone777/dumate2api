// test/unit/last-error-stale.test.js - `isStale`：数据新鲜度判据（P2-9 配套）
//
// 出处：账号页的「额度更新于 N 分钟前」标记。轮询刻意不刷额度（每号 4 次上游，
// 见 test/verify-workbuddy-accounts-poll.js），所以额度只在上次手动刷新那一刻
// 有效；不标出来就是「看起来实时、其实是几分钟前的数字」——本项目最忌讳的假象。
//
// 为什么单独测：判据若写在组件里，只能靠肉眼等够 TTL 才能验证一次，回归必然漂。
// 抽成纯函数后可以把「边界值、空值、未来时间戳」都钉死。
//
// 运行：node --test test/unit/last-error-stale.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const UTIL = path.join(__dirname, '..', '..', 'web', 'src', 'utils', 'lastError.ts');
let u;

test('加载 web/src/utils/lastError.ts', async () => {
  u = await import(pathToFileURL(UTIL).href);
  assert.equal(typeof u.isStale, 'function');
  // 老函数仍在（消费者依赖它们，不能因为加新函数把它们挪走）
  assert.equal(typeof u.relTime, 'function');
  assert.equal(typeof u.lastErrorFresh, 'function');
});

function U() {
  assert.ok(u, 'lastError 模块未加载');
  return u;
}

const TTL = 5 * 60 * 1000;
const T0 = 1_800_000_000_000;   // 固定基准时刻，不用 Date.now()（可重复）

test('isStale：TTL 内算新鲜', () => {
  const { isStale } = U();
  assert.equal(isStale(T0, TTL, T0), false, '刚更新');
  assert.equal(isStale(T0, TTL, T0 + 1000), false, '1 秒');
  assert.equal(isStale(T0, TTL, T0 + TTL - 1), false, '差 1ms 到期');
});

test('isStale：正好等于 TTL 不算过期，超一点点就算', () => {
  const { isStale } = U();
  assert.equal(isStale(T0, TTL, T0 + TTL), false, '恰好 TTL：边界选「不算」');
  assert.equal(isStale(T0, TTL, T0 + TTL + 1), true);
});

test('isStale：没有时间戳不算过期（「尚未读取」是另一句话）', () => {
  const { isStale } = U();
  // 关键区分：旧数据过期 vs 从来没有数据，界面话术与处置都不同，
  // 混成同一个「已过期」会让「刚打开页面还没拉到数」被误标成数据坏了
  assert.equal(isStale(null, TTL, T0), false);
  assert.equal(isStale(undefined, TTL, T0), false);
});

test('isStale：TTL <= 0 表示永不过期', () => {
  const { isStale } = U();
  assert.equal(isStale(T0, 0, T0 + 999999999), false);
  assert.equal(isStale(T0, -1, T0 + 999999999), false);
  assert.equal(isStale(T0, NaN, T0 + 999999999), false, 'NaN 不应变成「永远过期」');
});

test('isStale：时间戳在未来（时钟回拨/跨机）算新鲜，不误报', () => {
  const { isStale } = U();
  assert.equal(isStale(T0 + 60000, TTL, T0), false);
});
