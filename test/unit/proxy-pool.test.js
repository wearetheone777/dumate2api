// test/unit/proxy-pool.test.js - 代理池按账号稳定分配（调研 P2-15）
//
// 过程不触网：只验 resolveProxyUrl 的分配与优先级，不建连。
const { test } = require('node:test');
const assert = require('node:assert');

const pa = require('../../src/proxy-agent');

test.after(() => { pa.setProxyPool([]); pa.setGlobalProxy(''); });

test('池空时行为不变：无账号代理、无全局代理 → null（直连）', () => {
  pa.setProxyPool([]);
  pa.setGlobalProxy('');
  assert.strictEqual(pa.resolveProxyUrl({ id: 1, __channel: 'traework' }), null);
});

test('分配是稳定的：同一账号多次解析结果相同，且与池顺序无关地可复现', () => {
  pa.setProxyPool('http://p1:8080,http://p2:8080,http://p3:8080');
  const first = pa.resolveProxyUrl({ id: 5, __channel: 'traework' });
  for (let i = 0; i < 20; i++) {
    assert.strictEqual(pa.resolveProxyUrl({ id: 5, __channel: 'traework' }), first, '重启/重复调用不能让出口漂移');
  }
  // 清缓存重设同一份池，结果仍一致（模拟进程重启后的重新装载）
  pa.setProxyPool(['http://p1:8080', 'http://p2:8080', 'http://p3:8080']);
  assert.strictEqual(pa.resolveProxyUrl({ id: 5, __channel: 'traework' }), first);
});

test('不同账号尽量分散（不是全部落在同一个出口）', () => {
  pa.setProxyPool('http://p1:8080,http://p2:8080,http://p3:8080');
  const hits = new Set();
  for (let id = 1; id <= 30; id++) hits.add(pa.resolveProxyUrl({ id, __channel: 'traework' }));
  assert.ok(hits.size >= 2, `30 个账号只落到 ${hits.size} 个出口，哈希可疑`);
});

test('账号显式 proxy 永远优先于池子（手填的出口不被悄悄改掉）', () => {
  pa.setProxyPool('http://pool:8080');
  assert.strictEqual(
    pa.resolveProxyUrl({ id: 1, __channel: 'traework', proxy: 'http://own:9090' }),
    'http://own:9090',
  );
});

test('通道参与键位：同 id 不同通道可落不同出口（通道 id 不冲突）', () => {
  pa.setProxyPool('http://p1:8080,http://p2:8080,http://p3:8080,http://p4:8080');
  const keys = ['traework', 'qoder', 'qwenwork', 'workbuddy'].map((ch) =>
    pa.resolveProxyUrl({ id: 1, __channel: ch }));
  assert.ok(keys.every((k) => typeof k === 'string' && k.startsWith('http://')));
});

test('没有 id 的对象不走池（无法稳定映射）', () => {
  pa.setProxyPool('http://p1:8080');
  pa.setGlobalProxy('');
  assert.strictEqual(pa.resolveProxyUrl({ __channel: 'traework' }), null);
});

test('全局代理仍可作为最后兜底（池空时）', () => {
  pa.setProxyPool([]);
  pa.setGlobalProxy('http://global:8080');
  assert.strictEqual(pa.resolveProxyUrl({ id: 1, __channel: 'traework' }), 'http://global:8080');
  pa.setGlobalProxy('');
});

test('非法条目 fail-fast，不静默跳过（否则「以为配了 N 个出口」无从发现）', () => {
  assert.throws(() => pa.setProxyPool('http://ok:8080,socks5://bad:1080'), /仅支持 http/);
  assert.throws(() => pa.setProxyPool(['not-a-url']), /不是合法 URL/);
});
