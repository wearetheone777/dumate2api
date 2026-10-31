// test/unit/qwen-search.test.js - 千问联网搜索 / 图搜的纯函数（2026-10-31）
//
// 形状取自官方 1.4.0 客户端解包（docs/QWENWORK-CLIENT-1.4.0-ANALYSIS.md §3）：
//   webSearch: {query, [allowed_domains], [blocked_domains], timeRange, contents}
//   imageSearch: {query, count}，count ∈ [1, 10]
// 响应解析按客户端 tkd()/rkd() 的候选字段表。
const { test } = require('node:test');
const assert = require('node:assert');
const s = require('../../src/qwenwork/search');

test('webSearch 请求体形状与客户端一致', () => {
  const b = s.buildWebSearchPayload({ query: '  Node.js 24  ' });
  assert.equal(b.query, 'Node.js 24'); // 去空白
  assert.equal(b.timeRange, 'NoLimit');
  assert.deepEqual(b.contents, { mainText: false, markdownText: false, summary: false });
  // 未传域名过滤时不出现这两个键（客户端是条件展开）
  assert.equal('allowed_domains' in b, false);
  assert.equal('blocked_domains' in b, false);
});

test('webSearch 域名过滤只在非空数组时带', () => {
  const b = s.buildWebSearchPayload({ query: 'x', allowedDomains: ['a.com'], blockedDomains: [] });
  assert.deepEqual(b.allowed_domains, ['a.com']);
  assert.equal('blocked_domains' in b, false);
});

test('webSearch 空 query 报 400', () => {
  assert.throws(() => s.buildWebSearchPayload({ query: '   ' }), (e) => e.statusCode === 400);
  assert.throws(() => s.buildWebSearchPayload({}), (e) => e.statusCode === 400);
});

test('imageSearch 默认 count = 10（客户端上限）', () => {
  assert.equal(s.buildImageSearchPayload({ query: 'cat' }).count, 10);
});

test('imageSearch count 越界报 400（客户端同一规则）', () => {
  for (const bad of [0, 11, -1, 1.5, 'abc']) {
    assert.throws(() => s.buildImageSearchPayload({ query: 'x', count: bad }), (e) => e.statusCode === 400);
  }
  for (const ok of [1, 5, 10]) {
    assert.equal(s.buildImageSearchPayload({ query: 'x', count: ok }).count, ok);
  }
});

test('parseWebSearchResponse 认 pageItems 与 page_items 两种写法', () => {
  const one = s.parseWebSearchResponse(JSON.stringify({
    errorCode: 0,
    pageItems: [{ title: 'A', link: 'http://a', snippet: 's', publishedTime: 't', hostname: 'a.com' }],
  }));
  assert.equal(one.ok, true);
  assert.equal(one.items.length, 1);
  assert.equal(one.items[0].link, 'http://a');

  const two = s.parseWebSearchResponse(JSON.stringify({
    error_code: 0, page_items: [{ title: 'B', url: 'http://b' }],
  }));
  assert.equal(two.ok, true);
  assert.equal(two.items[0].link, 'http://b'); // url 是 link 的别名
});

test('parseWebSearchResponse 非零 errorCode 判失败', () => {
  const r = s.parseWebSearchResponse(JSON.stringify({ errorCode: 400, errorMsg: 'bad query' }));
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 400);
  assert.match(r.error, /bad query/);
});

test('parseWebSearchResponse 非 JSON 不静默成空结果', () => {
  const r = s.parseWebSearchResponse('<html>502</html>');
  assert.equal(r.ok, false);
  assert.match(r.error, /不是 JSON/);
});

test('搜索条目全空字段时不算结果（避免空壳进列表）', () => {
  const r = s.parseWebSearchResponse(JSON.stringify({ errorCode: 0, pageItems: [{}, null, 'x'] }));
  assert.equal(r.items.length, 0);
});

test('parseImageSearchResponse 认 results / data.items 两层', () => {
  const flat = s.parseImageSearchResponse(JSON.stringify({
    results: [{ image_url: 'u', thumbnail_url: 't', title: 'T', hostname: 'h', width: 10 }],
  }));
  assert.equal(flat.ok, true);
  assert.equal(flat.items[0].imageUrl, 'u');
  assert.equal(flat.items[0].width, 10);

  const nested = s.parseImageSearchResponse(JSON.stringify({ data: { items: ['http://x/y.png'] } }));
  assert.equal(nested.items.length, 1);
  assert.equal(nested.items[0].imageUrl, 'http://x/y.png');
});

test('图搜条目字段候选表：imageUrl 缺失时用缩略图兜底', () => {
  const r = s.parseImageSearchResponse(JSON.stringify({
    results: [{ thumbnailUrl: 'thumb', title: '只有缩略图' }],
  }));
  assert.equal(r.items[0].imageUrl, 'thumb');
  assert.equal(r.items[0].thumbnailUrl, 'thumb');
});

test('图搜空结果如实返回空数组，不报错', () => {
  const r = s.parseImageSearchResponse(JSON.stringify({ results: [] }));
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 0);
});

test('count 边界常量与客户端一致', () => {
  assert.equal(s.IMAGE_COUNT_MIN, 1);
  assert.equal(s.IMAGE_COUNT_MAX, 10);
});
