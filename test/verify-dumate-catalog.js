// test/verify-dumate-catalog.js - 搭子模型清单（三级降级 + 过滤规则）的离线验证
//
// 2026-11-15 融合 P0-1。不依赖任何运行中的服务，也不碰真实账号：
// 在临时目录里造一份假的 auth.json + opencode.json，逐条验证清单模块。
//
// 覆盖：
//   ① 真相源读取（含激活账号定位）与过滤规则（7 类排除 + 重复别名 + 缺元数据）
//   ② 防注入：源里的 apiKey / baseURL / headers 绝不进入清单
//   ③ 三级降级：desktop → snapshot → default
//   ④ 篡改快照读回时仍被过滤器清洗（schema + 字段白名单）
//   ⑤ 与 modelmap 的接线：mapModel 对清单名直传（防静默兜底）、verified 判据
//
// 用法：node test/verify-dumate-catalog.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let failures = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`[${mark}] ${label}${detail ? ' — ' + detail : ''}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-catalog-'));
process.env.DUMATE_ADMIN_DATA = TMP;
process.env.DUMATE_USER_DATA_DIR = path.join(TMP, 'appdata');

const catalog = require('../src/dumate-catalog');
const modelmap = require('../src/modelmap');

const APPDATA = process.env.DUMATE_USER_DATA_DIR;
const ACCOUNT = 'acct-1234';
const SRC = path.join(APPDATA, 'qianfan_desk_xdg', ACCOUNT, 'config', 'opencode', 'opencode.json');

/** 造一份最小可用的客户端配置：内含应保留项与全部应排除项 */
function writeSource(extra) {
  fs.mkdirSync(path.dirname(SRC), { recursive: true });
  fs.writeFileSync(path.join(APPDATA, 'auth.json'), JSON.stringify({
    activeProfileId: 'p1',
    accountProfiles: [{ profileId: 'p1', bceAccountId: ACCOUNT, displayName: '测试账号' }],
  }), 'utf8');
  const models = Object.assign({
    // —— 应保留 ——
    'model-text': {
      id: 'model-text', limit: { context: 1000000, output: 384000 },
      tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] },
      // 噪音字段：不许进清单
      apiKey: 'SECRET-KEY-SHOULD-NOT-LEAK', baseURL: 'http://127.0.0.1:1234', headers: { 'X-Evil': '1' },
    },
    'kimi-k31': { id: 'kimi-k31', limit: { context: 1048576, output: 1048576 }, modalities: { input: ['text'] } },
    // 显示别名指向源里真实条目 → 去重
    'glm-5': { id: 'model-text', limit: { context: 1000, output: 1000 } },
    // limit 只有 input 没有 context → 取 input
    'only-input': { id: 'only-input', limit: { input: 500, output: 100 }, modalities: { input: ['text'] } },

    // —— 应排除 ——
    'model-artifact-validate': { id: 'model-artifact-validate', limit: { context: 1000, output: 100 } },
    'llm-mock': { id: 'llm-mock', limit: { context: 1000, output: 100 } },
    'text-embedding-3': { id: 'text-embedding-3', limit: { context: 1000, output: 100 } },
    'bge-reranker': { id: 'bge-reranker', limit: { context: 1000, output: 100 } },
    'ocr-v2': { id: 'ocr-v2', limit: { context: 1000, output: 100 } },
    'dumate-image2.2': { id: 'dumate-image2.2', limit: { context: 1000, output: 100 } },
    // 缺 output → 跳过
    'no-output': { id: 'no-output', limit: { context: 1000 } },
    // 输入模态不含 text → 跳过
    'image-only': { id: 'image-only', limit: { context: 1000, output: 100 }, modalities: { input: ['image'] } },
  }, extra || {});
  fs.writeFileSync(SRC, JSON.stringify({ provider: { QianfanPersonalQuota: { models } } }), 'utf8');
}

// ---------------- ① 真相源与过滤规则 ----------------
writeSource();
catalog.resetCache();

const ids = catalog.ids();
const got = new Set(ids);
check('sourcePath 命中激活账号目录', catalog.sourcePath() === SRC, catalog.sourcePath());
check('从 desktop 读，asOf 空（真机配置不带版本）', catalog.load().source === 'desktop');
check('应保留项全部在（model-text / kimi-k31 / only-input）',
  got.has('model-text') && got.has('kimi-k31') && got.has('only-input'), ids.join(','));
check('显示别名去重（glm-5 被丢）', !got.has('glm-5'));
check('model-* 排除（model-text 例外，model-artifact-validate 被丢）',
  got.has('model-text') && !got.has('model-artifact-validate'));
check('mock / embedding / reranker / ocr / dumate-image 全排除',
  !got.has('llm-mock') && !got.has('text-embedding-3') && !got.has('bge-reranker')
  && !got.has('ocr-v2') && !got.has('dumate-image2.2'));
check('缺 output 的跳过', !got.has('no-output'));
check('输入模态不含 text 的跳过', !got.has('image-only'));
check('limit.context 缺失时取 limit.input', catalog.get('only-input').limit.context === 500);

// ---------------- ② 防注入 ----------------
const raw = JSON.stringify(catalog.load().models);
check('apiKey 不进清单', !/SECRET-KEY-SHOULD-NOT-LEAK/.test(raw));
check('baseURL 不进清单', !/127\.0\.0\.1:1234/.test(raw));
check('headers 不进清单', !/X-Evil/.test(raw));
const mt = catalog.get('model-text');
check('model-text 元数据形状正确（context/output/视觉）',
  mt.limit.context === 1000000 && mt.limit.output === 384000 && mt.attachment === true);

// ---------------- ③ 快照写入与降级 ----------------
const SNAP = catalog.filePath();
check('快照已落盘', fs.existsSync(SNAP), SNAP);
const snapJson = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
check('快照带 schema 与 asOf', snapJson.schema === 1 && /^\d{4}-\d{2}-\d{2}$/.test(snapJson.asOf), snapJson.asOf);
check('快照不含密钥', !/SECRET/.test(fs.readFileSync(SNAP, 'utf8')));

// 删源 → 走快照
fs.rmSync(SRC);
catalog.resetCache();
const viaSnap = catalog.load();
check('源缺失 → 降级 snapshot', viaSnap.source === 'snapshot', viaSnap.source);
check('快照降级后条目一致', Object.keys(viaSnap.models).sort().join(',') === ids.join(','));

// 删快照 → 走包内默认（22 条）
fs.rmSync(SNAP);
catalog.resetCache();
const viaDefault = catalog.load();
check('源与快照都缺 → 降级 default', viaDefault.source === 'default', viaDefault.source);
check('包内默认是 22 条', Object.keys(viaDefault.models).length === 22, String(Object.keys(viaDefault.models).length));

// ---------------- ④ 篡改快照仍被清洗 ----------------
fs.writeFileSync(SNAP, JSON.stringify({
  schema: 1,
  asOf: '2026-01-01',
  models: {
    'model-text': { id: 'model-text', limit: { context: 1, output: 1 }, apiKey: 'LEAKED-KEY', baseURL: 'http://evil' },
    'model-secret': { id: 'model-secret', limit: { context: 2, output: 2 } },
  },
}), 'utf8');
catalog.resetCache();
const tampered = catalog.load();
const tamperedRaw = JSON.stringify(tampered.models);
check('篡改快照 → 仍走过滤器', tampered.source === 'snapshot' && Object.keys(tampered.models).length === 1);
check('篡改快照的 apiKey 被清洗', !/LEAKED-KEY/.test(tamperedRaw));
check('篡改快照的 model-* 被排除', !tamperedRaw.includes('model-secret'));

// 坏 schema → 继续往下降级
fs.writeFileSync(SNAP, JSON.stringify({ schema: 99, models: {} }), 'utf8');
catalog.resetCache();
check('坏 schema → 继续降到 default', catalog.load().source === 'default');

// ---------------- ⑤ 与 modelmap 的接线 ----------------
fs.rmSync(SNAP, { force: true });
catalog.resetCache();
const cfg = modelmap.load();
// 直传**按链路**：云端链路（opts.catalog）认清单名，桌面链路保持兜底
check('云端链路：清单名直传（kimi-k31 不再兜底）', modelmap.mapModel('kimi-k31', { catalog: true }) === 'kimi-k31');
check('桌面链路：清单名仍落 fallback（8980 不认识它）', modelmap.mapModel('kimi-k31') === cfg.fallback);
check('云端链路：清单外的名字仍兜底', modelmap.mapModel('definitely-not-a-model', { catalog: true }) === cfg.fallback);
check('云端链路：[1M] 后缀仍剥壳', modelmap.mapModel('kimi-k31[1M]', { catalog: true }) === 'kimi-k31');
check('别名表行为不变（gpt-4o → model-text）', modelmap.mapModel('gpt-4o') === 'model-text');

const exposed = modelmap.catalogExposed();
const exposedIds = new Set(exposed.map((x) => x.id));
check('catalogExposed 不含 exposed 里已有的条目',
  !cfg.exposed.some((id) => exposedIds.has(id)), cfg.exposed.join(','));
// 差额 = 清单条目数 − 与 exposed 的交集（交集中 model-artifact-validate / glm-5
// 根本不在清单里，所以不能直接用 cfg.exposed.length 减）
const catIds = [...modelmap.catalogModels()];
const overlap = catIds.filter((id) => cfg.exposed.includes(id)).length;
check('catalogExposed 覆盖清单 22 条中的差额', exposed.length === 22 - overlap,
  `${exposed.length}（22 − 交集 ${overlap}）`);
const verifiedCount = exposed.filter((x) => x.verified).length;
check('verified 判据来自实测集合（云端 7 + 本地 3 中未暴露的部分）', verifiedCount > 0, `verified=${verifiedCount}`);
check('未实测的条目 verified:false', exposed.some((x) => !x.verified));
process.env.DUMATE_EXPOSE_CATALOG = '0';
check('DUMATE_EXPOSE_CATALOG=0 关闭追加', modelmap.catalogExposed().length === 0);
delete process.env.DUMATE_EXPOSE_CATALOG;

// ---------------- 收尾 ----------------
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* Windows 上可能被占用 */ }

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
