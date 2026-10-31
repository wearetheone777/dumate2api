// test/unit/dumate-web-api.test.js - 搭子网页端只读接口的归一化（2026-10-31）
//
// 形状取自真机响应（www.dumate.cn，cookie 鉴权）：
//   session/list   { code:0, success:true, result:[session...] }
//   session/detail { code:0, result:{...} }   ← 参数名必须是 sessionID
//   connector 模板  { code:0, result:{ total, list:[...] } }
const { test } = require('node:test');
const assert = require('node:assert');
const api = require('../../src/dumate-web-api');

test('normalizeSession 搬标题/时间/目录/档位', () => {
  const s = api.normalizeSession({
    id: 'ses_x',
    title: '问候打招呼',
    directory: 'C:\\Users\\Administrator\\.qianfan\\workspace\\sessions\\x\\2026-10-31\\new-chat',
    projectID: 'global',
    slug: 'quick-engine',
    type: 'work',
    source: 'manual',
    execEnv: 'desktop',
    autoModelLevel: 'L0',
    isPinned: false,
    is_subagent: false,
    time: { created: 1793391463965, updated: 1793391469381 },
  });
  assert.equal(s.id, 'ses_x');
  assert.equal(s.title, '问候打招呼');
  assert.equal(s.projectId, 'global'); // projectID → projectId
  assert.equal(s.autoModelLevel, 'L0');
  assert.equal(s.isSubagent, false);   // is_subagent → isSubagent
  assert.equal(s.updated, 1793391469381);
  assert.equal(s.summary, null);       // 没有 summary 时如实 null
});

test('normalizeSession 字段缺失给 null，不补空串', () => {
  const s = api.normalizeSession({ id: 'ses_y' });
  assert.equal(s.title, null);
  assert.equal(s.directory, null);
  assert.equal(s.created, null);
  assert.equal(s.isPinned, null);  // 上游没给布尔 → null 而不是 false
});

test('normalizeSession 保留代码改动统计（部分会话带）', () => {
  const s = api.normalizeSession({
    id: 'ses_z', summary: { additions: 10, deletions: 3, files: 2 },
  });
  assert.deepEqual(s.summary, { additions: 10, deletions: 3, files: 2 });
});

test('normalizeSession 非法输入返回 null', () => {
  assert.equal(api.normalizeSession(null), null);
  assert.equal(api.normalizeSession('x'), null);
});

test('normalizeConnector 搬接入方式与 serverUrl', () => {
  const c = api.normalizeConnector({
    id: 'f87146d3-1464-49d0-bc6b-37f5908a095a',
    code: 'hyper3d',
    templateCode: 'hyper3d',
    name: 'Hyper3D Rodin 模型生成',
    source: 'builtin',
    connectionStatus: 'uninstalled',
    enabled: false,
    config: {
      transProtocol: 'streamablehttp',
      serverUrl: 'https://api.hyper3d.com/api/mcp',
      authType: 'oauth2',
    },
  });
  assert.equal(c.code, 'hyper3d');
  assert.equal(c.transProtocol, 'streamablehttp');
  assert.equal(c.serverUrl, 'https://api.hyper3d.com/api/mcp');
  assert.equal(c.authType, 'oauth2');
  assert.equal(c.connectionStatus, 'uninstalled');
});

test('normalizeConnector 用 templateCode 兜底 code', () => {
  const c = api.normalizeConnector({ id: 'x', templateCode: 'tk' });
  assert.equal(c.code, 'tk');
});

test('apiError：HTTP 200 但 code 非 0 判失败（不是「查到空结果」）', () => {
  const e = api.apiError(
    { status: 200, json: { code: 400, message: '参数错误:SessionID', success: false }, raw: '' },
    '会话详情',
  );
  assert.ok(e);
  assert.match(e, /code=400/);
  assert.match(e, /参数错误/);
});

test('apiError：code=0 且 success=true 才算成功', () => {
  assert.equal(api.apiError({ status: 200, json: { code: 0, success: true, result: [] }, raw: '' }, 'x'), null);
});

test('apiError：success=false 即使 code=0 也算失败', () => {
  const e = api.apiError({ status: 200, json: { code: 0, success: false, message: 'denied' }, raw: '' }, 'x');
  assert.ok(e);
  assert.match(e, /success=false|denied/);
});

test('apiError：非 JSON（nginx 404 页）如实报 HTTP 状态', () => {
  const e = api.apiError({ status: 404, json: null, raw: '<html>404</html>' }, 'x');
  assert.match(e, /HTTP 404/);
});

test('apiError：网络错误 status=0 报网络错误', () => {
  const e = api.apiError({ status: 0, json: null, raw: '', error: 'ECONNREFUSED' }, 'x');
  assert.match(e, /网络错误|ECONNREFUSED/);
});

test('skillsSquare 如实返回「端点不存在」而不是编 URL', () => {
  return api.skillsSquare().then((r) => {
    assert.equal(r.ok, false);
    assert.equal(r.unsupported, true);
    assert.match(r.error, /404/);
  });
});
