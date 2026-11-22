// test/unit/workbuddy-accounts-paging.test.js - 账号表客户端分页 / 排序 / 轮询去重（P2-9）
//
// 出处：docs/WORKBUDDY-FUSION.md P2-9（hub：「每页 50、排序筛选作用于全量再切页、
// 15 秒轮询数据没变不整表重画」）。
//
// 被测的是 `web/src/utils/paging.ts`，直接按路径 import——Node 24 的
// **类型擦除**（type stripping）让 .ts 能被 require/import，不需要先构建。
// 这是刻意保留的能力：这些行为若只靠界面目测，回归会漂（分页边界尤其难看出来）。
//
// 锁的三条口径：
//   1. 排序/筛选作用于**全量**再切页（先切页再排序会让每页各自成序）
//   2. 页码**夹紧**（删账号/减页大小后不能渲染成空白）
//   3. **null 排最后**（未知既不是 0 也不是 -1；排在「积分 0」前面会把未知
//      当成最紧急的账号）
//
// 运行：node --test test/unit/workbuddy-accounts-paging.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const WEB_UTILS = path.join(__dirname, '..', '..', 'web', 'src', 'utils');
let pg;

test('加载 web/src/utils/paging.ts', async () => {
  pg = await import(pathToFileURL(path.join(WEB_UTILS, 'paging.ts')).href);
  assert.equal(typeof pg.pageSlice, 'function');
  assert.equal(typeof pg.sameSig, 'function');
});

function P() {
  assert.ok(pg, 'paging 模块未加载');
  return pg;
}

// ---------- 页数 / 夹紧 ----------

test('pageCount：0 条 = 0 页（界面据此不出分页条）', () => {
  const { pageCount } = P();
  assert.equal(pageCount(0, 50), 0);
  assert.equal(pageCount(1, 50), 1);
  assert.equal(pageCount(50, 50), 1);
  assert.equal(pageCount(51, 50), 2);
  assert.equal(pageCount(100, 50), 2);
  assert.equal(pageCount(101, 50), 3);
});

test('pageCount / pageSlice：页大小非法（0/负/NaN）退化为 1，不抛不除零', () => {
  const { pageCount, pageSlice } = P();
  for (const bad of [0, -5, NaN, undefined]) {
    assert.equal(pageCount(10, bad), 10, `pageSize=${bad} 应退化为 1`);
    // 退化后每页 1 条：第 1 页只给第 1 条。判据是「不抛、不返回整表、
    // 不返回空」，而不是「一次给全部」——一次给全部就等于分页失效
    assert.deepEqual(pageSlice([1, 2, 3], 1, bad), [1], `pageSize=${bad} 每页应为 1 条`);
    assert.deepEqual(pageSlice([1, 2, 3], 3, bad), [3]);
  }
});

test('clampPage：越界夹进区间，空集合恒为 1（分页器需要非 0 current）', () => {
  const { clampPage } = P();
  assert.equal(clampPage(0, 0, 50), 1);
  assert.equal(clampPage(99, 0, 50), 1);
  assert.equal(clampPage(0, 10, 50), 1);
  assert.equal(clampPage(-3, 10, 50), 1);
  assert.equal(clampPage(5, 10, 50), 1, '10 条只有 1 页');
  assert.equal(clampPage(5, 120, 50), 3, '120 条 3 页');
  assert.equal(clampPage(2, 120, 50), 2);
  assert.equal(clampPage(NaN, 120, 50), 1);
});

test('pageSlice：页码越界返最后一页而不是空数组', () => {
  const { pageSlice } = P();
  const rows = Array.from({ length: 7 }, (_, i) => i);
  assert.deepEqual(pageSlice(rows, 1, 3), [0, 1, 2]);
  assert.deepEqual(pageSlice(rows, 2, 3), [3, 4, 5]);
  assert.deepEqual(pageSlice(rows, 3, 3), [6]);
  // 第 9 页 → 夹到第 3 页（最后一页），不是 []
  assert.deepEqual(pageSlice(rows, 9, 3), [6], '越界应夹到最后一页');
  // 空集合 → []
  assert.deepEqual(pageSlice([], 1, 3), []);
});

// ---------- 排序（作用于全量） ----------

const rows = [
  { id: 1, expiresAt: 300 },
  { id: 2, expiresAt: null },
  { id: 3, expiresAt: 100 },
  { id: 4 },
];

test('sortRows：default 原样（保持后端顺序，不重排）', () => {
  const { sortRows } = P();
  assert.deepEqual(sortRows(rows, 'default', () => 0).map((r) => r.id), [1, 2, 3, 4]);
});

test('sortRows：积分升序，null 排最后（未知不当 0）', () => {
  const { sortRows } = P();
  const credits = { 1: 50, 2: null, 3: 0, 4: 10 };
  const out = sortRows(rows, 'credits-asc', (id) => credits[id]);
  assert.deepEqual(out.map((r) => r.id), [3, 4, 1, 2], '0 → 10 → 50 → 未知');
});

test('sortRows：积分降序，null 仍排最后（不是排最前）', () => {
  const { sortRows } = P();
  const credits = { 1: 50, 2: null, 3: 0, 4: 10 };
  const out = sortRows(rows, 'credits-desc', (id) => credits[id]);
  assert.deepEqual(out.map((r) => r.id), [1, 4, 3, 2], '50 → 10 → 0 → 未知');
});

test('sortRows：expiring 按到期时刻升序，无到期时间的排最后', () => {
  const { sortRows } = P();
  const out = sortRows(rows, 'expiring', () => 0);
  assert.deepEqual(out.map((r) => r.id), [3, 1, 2, 4], '100 → 300 → null → 缺字段');
});

test('sortRows：不修改入参（computed 里直接排原数组会让 status 快照变序）', () => {
  const { sortRows } = P();
  const src = [{ id: 2 }, { id: 1 }];
  const copy = src.map((r) => ({ ...r }));
  sortRows(src, 'expiring', () => 0);
  assert.deepEqual(src, copy, '入参数组不应被 sort 就地改动');
});

test('排序作用于全量再切页：翻页看到的是同一序列的相邻段', () => {
  const { sortRows, pageSlice } = P();
  const many = Array.from({ length: 120 }, (_, i) => ({ id: i, expiresAt: 1000 - i }));
  const credits = Object.fromEntries(many.map((r) => [r.id, r.id % 7]));
  const sorted = sortRows(many, 'credits-asc', (id) => credits[id]);
  const p1 = pageSlice(sorted, 1, 50).map((r) => r.id);
  const p2 = pageSlice(sorted, 2, 50).map((r) => r.id);
  const p3 = pageSlice(sorted, 3, 50).map((r) => r.id);
  assert.equal(p1.length + p2.length + p3.length, 120, '三页拼起来必须正好是全量');
  assert.equal(new Set([...p1, ...p2, ...p3]).size, 120, '跨页不能重复/遗漏');
  // 拼接后仍然是全量排序结果（这就是「先排序再切页」的判据）
  assert.deepEqual([...p1, ...p2, ...p3], sorted.map((r) => r.id));
});

// ---------- 轮询去重 ----------

test('sameSig：内容相同的两个对象签名相同（依赖它跳过整表重画）', () => {
  const { sameSig } = P();
  assert.equal(sameSig({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] }), true);
  assert.equal(sameSig([{ x: null }], [{ x: null }]), true);
  // 键序不同也算不同（上游没有稳定键序的承诺；宁可多画一次也不漏更新）
  assert.equal(sameSig({ a: 1, b: 2 }, { b: 2, a: 1 }), false);
});

test('sameSig：真实差异必须判为不同（不能因为 undefined/NaN 漏更新）', () => {
  const { sameSig } = P();
  assert.equal(sameSig({ total: null }, { total: 0 }), false, 'null ≠ 0');
  assert.equal(sameSig({ total: 5 }, { total: 5.5 }), false);
  assert.equal(sameSig({ rows: [] }, { rows: [{ id: 1 }] }), false);
  assert.equal(sameSig(undefined, undefined), true);
  assert.equal(sameSig(undefined, null), false, 'undefined ≠ null');
});

test('stableSig：undefined 有独立签名（不能与空串混同）', () => {
  const { stableSig } = P();
  assert.notEqual(stableSig(undefined), stableSig(''));
  assert.equal(stableSig(undefined), 'undefined');
});
