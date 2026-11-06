// test/unit/workbuddy-proxy.test.js - 账号级出站代理（M2.1）
//
// 覆盖三件事：
//   1. list() 的脱敏：原始 URL 带 user:pass 时，管理端出口只能看到 *** 形态
//   2. proxy-agent 的解析：配了代理的账号 getAgentFor 必须返回 agent（绝不
//      静默回退直连——那是把真实出口 IP 裸奔出去）
//   3. normalizeProxyUrl 的校验边界（保存时暴露配置错误）
//
// 运行：node --test test/unit/workbuddy-proxy.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-wb-proxy-'));
process.env.DUMATE_ADMIN_DATA = TMP;

const auth = require('../../src/workbuddy/auth');
const proxyAgent = require('../../src/proxy-agent');

const RAW = 'http://alice:s3cret@10.0.0.8:8080';
const REDACTED = 'http://alice:***@10.0.0.8:8080';

test('配代理的账号：list() 只给脱敏形态，原始凭证不出进程', () => {
  auth.upsert({ uid: 'uid-proxy-1', region: 'cn', accessToken: 'at', refreshToken: 'rt', proxy: RAW });
  const rows = auth.list();
  const hit = rows.find((r) => r.uid === 'uid-proxy-1');
  assert.ok(hit, '账号应存在');
  assert.strictEqual(hit.proxy, REDACTED, `应显示 ${REDACTED}，实得 ${hit.proxy}`);
  // 泄漏检查：整个 JSON 形状里不能出现明文密码
  const blob = JSON.stringify(rows);
  assert.ok(!blob.includes('s3cret'), 'list() 输出不得包含代理明文凭证');
  // 原始 URL 仍留在存储里（网关建连要用）
  const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'workbuddy-accounts.json'), 'utf8'));
  assert.strictEqual(raw.accounts.find((a) => a.uid === 'uid-proxy-1').proxy, RAW);
});

test('配了代理就必须解析出 agent——绝不静默回退直连', () => {
  const rec = auth.get(auth.list().find((r) => r.uid === 'uid-proxy-1').id);
  const agent = proxyAgent.getAgentFor(rec);
  assert.ok(agent, 'getAgentFor 必须返回 agent');
  assert.strictEqual(agent.constructor.name, 'HttpConnectAgent');
});

test('清除代理后：describeProxy 为 null，getAgentFor 直连（无全局代理时）', () => {
  const id = auth.list().find((r) => r.uid === 'uid-proxy-1').id;
  auth.patch(id, { proxy: '' });
  const rec = auth.get(id);
  assert.strictEqual(proxyAgent.describeProxy(rec), null);
  // 注意：globalProxy 为空时才返回 null；若环境设了 DUMATE_PROXY 会回落全局
  const saved = process.env.DUMATE_PROXY;
  delete process.env.DUMATE_PROXY;
  try {
    proxyAgent.setGlobalProxy('');
    assert.strictEqual(proxyAgent.getAgentFor(rec), null);
  } finally {
    proxyAgent.setGlobalProxy(saved || '');
  }
});

test('normalizeProxyUrl 校验边界（保存时暴露配置错误）', () => {
  // 合法：缺端口补 80，去路径
  assert.strictEqual(proxyAgent.normalizeProxyUrl('http://1.2.3.4:8080/x'), 'http://1.2.3.4:8080');
  // 非法：非 http 协议（首版只支持 CONNECT 隧道）
  assert.throws(() => proxyAgent.normalizeProxyUrl('socks5://1.2.3.4:1080'), /http/);
  // 非法：无 host / 不是 URL（错误文案是「不是合法 URL」，不预编措辞，只认事实）
  assert.throws(() => proxyAgent.normalizeProxyUrl('http://'), /URL/);
  assert.throws(() => proxyAgent.normalizeProxyUrl('not-a-url'), /URL/);
});

test('账号新建时 upsert 也接受 proxy 字段（导入时即配代理）', () => {
  auth.upsert({ uid: 'uid-proxy-2', region: 'global', accessToken: 'at', refreshToken: 'rt', proxy: 'http://5.6.7.8:3128' });
  const rec = auth.get(auth.list().find((r) => r.uid === 'uid-proxy-2').id);
  assert.strictEqual(rec.proxy, 'http://5.6.7.8:3128');
  // 脱敏形态：无凭证的 URL 原样（无 user:pass 就没有可打码的部分）
  assert.strictEqual(proxyAgent.describeProxy(rec), 'http://5.6.7.8:3128');
});
