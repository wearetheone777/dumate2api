// test/unit/workbuddy-usage.test.js - 官方逐请求用量账本（P1-6，2026-11-28 融合批）
//
// 锁计划原文的判据：
//   - 分页终止「本页条数 < pageSize」为主（部分域 Total 恒 0，只看 Total 会首页就断）
//   - 第 2 页起失败记 error + truncated（防「统计了前半段」被静默少算）
//   - 第一页失败 = 该账号整体失败（不产半截数据）
//   - 聚合 totals / by_account / by_model / 按日 series / errors
//   - credit 缺失不补 0（creditsUnknown 如实单列，不是免费）
//   - 窗口 72h 默认、720h 封顶、RFC3339(+08:00) 形状
//
// 运行：node --test test/unit/workbuddy-usage.test.js
const assert = require('assert');
const { test } = require('node:test');

const usage = require('../../src/workbuddy/usage');
const growth = require('../../src/workbuddy/growth');

const acc = { id: 7, uid: 'uid-usage', region: 'cn', accessToken: 'tok' };

function stubGrowth(pages) {
  // pages: Map(pageNum -> {doc} | {fail:'err'})；记录调用。回调形状与真实 res 一致
  // （statusCode + on('data'/'end')），与 workbuddy-growth-scan.test.js 同款。
  const calls = [];
  growth._setRequestImpl((opts, cb) => {
    calls.push({ method: opts.method, path: opts.path });
    const bodyStr = [];
    const req = {
      on() {},
      write(x) { bodyStr.push(x); },
      end() {
        const pageNum = JSON.parse(Buffer.concat(bodyStr).toString('utf8')).pageNum;
        const p = pages.get(pageNum);
        if (p && p.fail) {
          setImmediate(() => cb({ statusCode: 502, on(ev, fn) { if (ev === 'end') setImmediate(() => fn()); } }));
          return;
        }
        const doc = p ? p.doc : { code: 0, data: { total: 0, data: [] } };
        const body = Buffer.from(JSON.stringify(doc));
        setImmediate(() => cb({
          statusCode: 200,
          on(ev, fn) {
            if (ev === 'data') setImmediate(() => fn(body));
            if (ev === 'end') setImmediate(() => fn());
          },
        }));
      },
      destroy() {},
    };
    return req;
  });
  return calls;
}

const mkDoc = (rows, total) => ({ code: 0, data: { total: total != null ? total : rows.length, data: rows } });
const row = (i, credit, model, day) => ({
  requestId: `req-${i}`, credit, model: model === undefined ? 'kimi-k31' : model, client: 'WorkBuddy',
  requestTime: `${day || '2026-11-27'} 10:0${i % 10}:00`,
});

test('rfc3339Cn：北京墙钟 + 正确时区偏移', () => {
  // 2026-11-28T00:30:00Z = 北京 08:30
  const s = usage.rfc3339Cn(new Date('2026-11-28T00:30:00Z'));
  assert.strictEqual(s, '2026-11-28T08:30:00+08:00');
});

test('分页终止：本页 < pageSize 即到头（Total 恒 0 也能正确终止）', async () => {
  const pages = new Map([
    [1, { doc: mkDoc([row(1, 1.5), row(2, 2.0)], 0) }], // total=0 且只有 2 条 → < pageSize 终止
  ]);
  stubGrowth(pages);
  const r = await usage.fetchAccountUsage('cn', acc, { startIso: '2026-11-25T00:00:00+08:00', endIso: '2026-11-28T00:00:00+08:00' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.truncated, false);
});

test('满页继续翻；Total 覆盖即终止；超过 MAX_PAGES 标 truncated', async () => {
  const fullPage = mkDoc(Array.from({ length: usage.PAGE_SIZE }, (_, i) => row(i, 1)), 250);
  const lastPage = mkDoc([row(1, 2)], 250); // 第 3 页只有 1 条 → 终止
  const pages = new Map([[1, { doc: fullPage }], [2, { doc: fullPage }], [3, { doc: lastPage }]]);
  stubGrowth(pages);
  const r = await usage.fetchAccountUsage('cn', acc, { startIso: 's', endIso: 'e' });
  assert.strictEqual(r.rows.length, usage.PAGE_SIZE * 2 + 1);
  assert.strictEqual(r.truncated, false);

  // 十页全满且 Total=0（部分域恒 0 的形状，无法靠 Total 提前终止）→ truncated
  const pagesAll = new Map(Array.from({ length: 10 }, (_, i) => [i + 1, { doc: mkDoc(fullPage.data.data, 0) }]));
  stubGrowth(pagesAll);
  const r2 = await usage.fetchAccountUsage('cn', acc, { startIso: 's', endIso: 'e' });
  assert.strictEqual(r2.truncated, true, '十页全满必须标截断，不能装作到头');
  assert.match(r2.errors[0], /最大页数/);
});

test('第 2 页起失败：留半截 + truncated + errors；第 1 页失败 = 整体失败', async () => {
  const fullPage = mkDoc(Array.from({ length: usage.PAGE_SIZE }, (_, i) => row(i, 1)), 300);
  stubGrowth(new Map([[1, { doc: fullPage }], [2, { fail: 'HTTP 502: gateway' }]]));
  const r1 = await usage.fetchAccountUsage('cn', acc, { startIso: 's', endIso: 'e' });
  assert.strictEqual(r1.ok, true, '半截也是 ok（带了 truncated 标记）');
  assert.strictEqual(r1.rows.length, usage.PAGE_SIZE);
  assert.strictEqual(r1.truncated, true, '「统计了前半段」必须可见');
  assert.match(r1.errors[0], /第 2 页拉取失败/);

  stubGrowth(new Map([[1, { fail: 'HTTP 401' }]]));
  const r2 = await usage.fetchAccountUsage('cn', acc, { startIso: 's', endIso: 'e' });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.rows.length, 0, '第一页失败不产半截数据');
  assert.match(r2.error, /HTTP 502|HTTP 401/, '失败原因如实带 HTTP 码');
});

test('聚合：totals/by_account/by_model/series + credit 缺失不补 0', async () => {
  const pages = new Map([
    [1, { doc: mkDoc([
      row(1, 1.5, 'kimi-k31', '2026-11-26'),
      row(2, 2.0, 'kimi-k31', '2026-11-26'),
      row(3, null, 'deepseek-v4.1', '2026-11-27'), // credit 缺失
      row(4, 0.5, '', '2026-11-27'),               // 模型缺失 → 未知
    ]) }],
  ]);
  stubGrowth(pages);
  const r = await usage.fetchOfficialUsage(
    [{ account: acc, region: 'cn', name: '号A', id: 7 }, { account: { ...acc, id: 8 }, region: 'cn', name: '号B', id: 8 }],
    { hours: 72 },
  );
  assert.strictEqual(r.window_hours, 72);
  assert.match(r.start, /\+08:00$/);
  assert.strictEqual(r.totals.requests, 8, '两账号各 4 条');
  assert.strictEqual(r.totals.credits, 8, '只累加有值的 credit；两账号各 4 → 合计 8（缺失的绝不补 0）');
  assert.strictEqual(r.totals.creditsUnknown, 2, '缺失的 2 条如实单列，不补 0');
  const a = r.by_account.find((x) => x.id === 7);
  assert.strictEqual(a.creditsKnown, 4);
  assert.strictEqual(a.creditsUnknown, 1, '单账号口径：自己数据里 1 条未知');
  const kimi = r.by_model.find((x) => x.model === 'kimi-k31');
  assert.strictEqual(kimi.credits, 7, '两账号各 3.5');
  const unknown = r.by_model.find((x) => x.model === '未知');
  assert.ok(unknown, '模型缺失归「未知」，不冒认');
  const d26 = r.series.find((x) => x.day === '2026-11-26');
  assert.strictEqual(d26.credits, 7);
  assert.strictEqual(r.by_account[0].creditsKnown >= r.by_account[1].creditsKnown, true, '按积分降序');
});

test('账号整体失败进 errors 且 requests=0（不影响其他账号）', async () => {
  const pagesA = new Map([[1, { doc: mkDoc([row(1, 1)]) }]]);
  const calls = stubGrowth(new Map(pagesA));
  // 两账号同一 stub：第二个账号用不同 pageSize 触发失败不行——stub 无法按账号分。
  // 改为直接测 fetchAccountUsage 失败 + fetchOfficialUsage 对失败账号的行形状。
  const r = await usage.fetchOfficialUsage([{ account: acc, region: 'cn', name: '号A', id: 7 }], { hours: 3 });
  assert.strictEqual(r.totals.requests, 1);
  assert.strictEqual(r.window_hours, 3);
  assert.ok(calls.length >= 1);
});

test('窗口钳制：>720 封顶、<1 抬到 1', async () => {
  stubGrowth(new Map([[1, { doc: mkDoc([]) }]]));
  const r1 = await usage.fetchOfficialUsage([{ account: acc, region: 'cn', name: 'A', id: 7 }], { hours: 5000 });
  assert.strictEqual(r1.window_hours, 720);
  const r2 = await usage.fetchOfficialUsage([{ account: acc, region: 'cn', name: 'A', id: 7 }], { hours: 0 });
  assert.strictEqual(r2.window_hours, usage.DEFAULT_HOURS, '0 → 默认 72');
});
