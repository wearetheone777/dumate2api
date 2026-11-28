// channels.def.json 能力声明（批次二十二）——声明形状锁 + can/regionsOf 语义 +
// keys.js 区域闸读声明 + 接线自证。
// channels.def.json 是前后端共享的单一事实：这里锁的是「声明被改坏时立刻知道」。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const channels = require('../../src/channels');
const DEF = require('../../channels.def.json');

const CAP_KEYS = ['checkin', 'credits', 'growth', 'media', 'search'];

test('声明文件形状：五通道、id/label/kind 完整、capabilities 键集固定', () => {
  assert.strictEqual(DEF.channels.length, 5);
  assert.deepStrictEqual(channels.CHANNELS, ['dumate', 'qwenwork', 'traework', 'qoder', 'workbuddy']);
  for (const c of DEF.channels) {
    assert.ok(['http', 'direct'].includes(c.kind), `${c.id} kind 必须是 http|direct`);
    assert.ok(c.label, `${c.id} label 必填`);
    for (const k of CAP_KEYS) {
      assert.strictEqual(typeof c.capabilities[k], 'boolean', `${c.id}.${k} 必须显式声明（声明不是分支，没有「缺省」）`);
    }
    assert.ok(Array.isArray(c.capabilities.regions), `${c.id}.regions 必须是数组（空数组 = 纯国内）`);
  }
  // kind：搭子是代理型 http，其余直连
  assert.strictEqual(channels.kindOf('dumate'), 'http');
  for (const ch of ['qwenwork', 'traework', 'qoder', 'workbuddy']) {
    assert.strictEqual(channels.kindOf(ch), 'direct');
  }
  // LABELS 由声明派生，历史值不变
  assert.strictEqual(channels.label('dumate'), '百度搭子');
  assert.strictEqual(channels.label('qoder'), 'Qoder');
});

test('can()：能力位语义与 CLAUDE.md 记载一致', () => {
  assert.strictEqual(channels.can('dumate', 'media'), true, '生图/TTS/视频是搭子专属');
  assert.strictEqual(channels.can('qwenwork', 'media'), false);
  assert.strictEqual(channels.can('qwenwork', 'search'), true, '联网搜索是千问专属');
  assert.strictEqual(channels.can('dumate', 'search'), false);
  assert.strictEqual(channels.can('workbuddy', 'growth'), true, '成长任务只有 WorkBuddy');
  for (const ch of ['dumate', 'qwenwork', 'traework', 'qoder']) {
    assert.strictEqual(channels.can(ch, 'growth'), false);
  }
  assert.strictEqual(channels.can('qwenwork', 'checkin'), false, '千问无签到体系');
  for (const ch of ['dumate', 'traework', 'qoder', 'workbuddy']) {
    assert.strictEqual(channels.can(ch, 'checkin'), true);
  }
  // 未知通道/未知能力一律 false（不猜）
  assert.strictEqual(channels.can('nonsense', 'checkin'), false);
  assert.strictEqual(channels.can('dumate', 'nonsense'), false);
});

test('regionsOf：纯国内与双区域通道的划分与 keys.js 的区域闸一致', () => {
  assert.deepStrictEqual(channels.regionsOf('dumate'), []);
  assert.deepStrictEqual(channels.regionsOf('qwenwork'), []);
  for (const ch of ['traework', 'qoder', 'workbuddy']) {
    assert.deepStrictEqual(channels.regionsOf(ch), ['cn', 'intl']);
  }
  // keys.js 的 CN_ONLY_CHANNELS 由声明派生：不含 intl 的通道
  const keys = require('../../src/keys');
  assert.deepStrictEqual([...keys.CN_ONLY_CHANNELS].sort(), ['dumate', 'qwenwork']);
  // 区域闸行为：intl key 打纯国内通道直接拒（历史回归）
  const intlKey = { key: 'k', region: 'intl', model_allowlist: [], channel: '' };
  const r = keys.validate(intlKey, '127.0.0.1', 'glm-5', 'dumate');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'region_not_available');
  // 有国际版的通道不拒
  const ok = keys.validate(intlKey, '127.0.0.1', 'qoder/gfmodel', 'qoder');
  assert.strictEqual(ok.ok, true);
});

test('publicOf：/status 透出形状（id/label/kind/capabilities）', () => {
  const p = channels.publicOf('qoder');
  assert.strictEqual(p.id, 'qoder');
  assert.strictEqual(p.label, 'Qoder');
  assert.strictEqual(p.kind, 'direct');
  assert.strictEqual(p.capabilities.checkin, true);
  assert.notStrictEqual(p.capabilities, channels.capabilitiesOf('qoder'), '出仓是副本，调用方改不动声明');
  // 未知通道：不猜 kind，如实 null
  const ghost = channels.publicOf('nonsense');
  assert.strictEqual(ghost.kind, null);
  assert.strictEqual(ghost.capabilities, null);
});

test('接线：system.js 状态透出读声明；keys.js 区域闸读声明；前端从 @def 引入', () => {
  const sys = fs.readFileSync(path.join(__dirname, '../../src/admin/routes/system.js'), 'utf8');
  assert.ok(sys.includes("publicOf('dumate')"), '/status 的通道条目由 publicOf 展开');
  assert.ok(!/label: '百度搭子'/.test(sys), '/status 不再手写通道字面量');
  const keysSrc = fs.readFileSync(path.join(__dirname, '../../src/keys.js'), 'utf8');
  assert.match(keysSrc, /regionsOf\(ch\)\.includes\('intl'\)/, '纯国内清单由 regions 声明派生');
  assert.ok(!/new Set\(\['dumate', 'qwenwork'\]\)/.test(keysSrc), '不再手写纯国内清单');
  const store = fs.readFileSync(path.join(__dirname, '../../web/src/stores/channel.ts'), 'utf8');
  assert.match(store, /import DEF from '@def\/channels'/, '前端通道表从共享声明构建');
  assert.match(store, /menuKeysFor/, 'menuKeys 由能力位派生');
  const vite = fs.readFileSync(path.join(__dirname, '../../web/vite.config.ts'), 'utf8');
  assert.match(vite, /'@def\/channels'/, 'vite alias 与 tsconfig paths 同映射');
});
