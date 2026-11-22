// src/route-groups.js - 自定义路由组（调研 P1-7 第一批：配置 + 可用性择优）
//
// 要解决的问题：同一个「对外模型名」在多条通道上都有等价能力，但**今天谁有号**
// 是浮动的（某个通道没登录、账号全冷却、全站暂停）。客户端不该为此改配置。
//
// 三条纪律（比功能本身重要）：
//   1. **组名必须显式命中**。请求的 model 恰好等于组名才算，绝不做「猜名字」。
//      这与 router「未知前缀报错、不静默回落」是同一条纪律——静默替换模型名
//      会让客户端拿到一个看起来成功、实际完全不是想要的结果。
//   2. **组名不带斜杠**。带斜杠的名字会被通道前缀路由当成通道名（`qwen/xxx`），
//      两套语义叠在同一个字符串上必然出错，所以直接拒绝。
//   3. **成员不能再是组名**。否则 A→B→A 是死循环，而配置错误只会在请求到来时
//      才暴露。校验在 `sanitize` 里一次做完，坏文件整体按「没有组」处理——
//      路由表坏掉不能把网关带下去。
//
// 第一批只做**可用性择优**：在分发之前逐个成员看 `availability()`，挑第一个
// 可用的；不碰「已经发出响应之后再换成员」（那要动翻译器的收尾语义，风险高，
// 见 CLAUDE.md 的 P1-7 第二条）。所以这里不解释错误种类，只解释「谁现在能用」。
//
// 文件是 `data/route-groups.json`（mtime 热读，与 keys/modelmap/livecfg 同一套纪律）：
//
//   { "groups": [
//       { "name": "fast", "members": ["qwen/pro", "traework/glm-5.2", "glm-5"] }
//   ] }
//
// 故意**不放进 `model-map.json`**：model-map 管「模型名怎么改写成上游名」，
// 而组是「从哪条通道走」，两件事混进一个文件后，`mapModel` 的兜底逻辑会把
// 组名安静地改写成 `model-text`——这正是本仓库反复踩过的那类静默故障。
const fs = require('fs');
const path = require('path');

const FILE = 'route-groups.json';
/** 成员上限：组是一张短的优先级表，20 个成员已经是「没想清楚」 */
const MAX_MEMBERS = 20;
/** 组名长度上限（进 header 与日志，别让人塞一整段话） */
const MAX_NAME = 48;

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
}

function filePath() {
  return path.join(dataDir(), FILE);
}

/**
 * 白名单清洗。返回**只含合法组**的数组；非法项逐条丢弃并在 `dropped` 里说明原因
 * （磁盘宽容：一个手写的配置文件写错一行，不该让整个路由表失效）。
 *
 * @param {any} raw 文件内容（{groups:[...]} 或裸数组都收）
 * @returns {{groups:Array<{name:string, members:string[]}>, dropped:Array<{name:string, why:string}>}}
 */
function sanitize(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.groups) ? raw.groups : []);
  const dropped = [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const name = String((item && item.name) || '').trim();
    if (!name) { dropped.push({ name: '', why: '缺少 name' }); continue; }
    if (name.length > MAX_NAME) { dropped.push({ name, why: `name 超过 ${MAX_NAME} 字符` }); continue; }
    if (name.includes('/')) {
      dropped.push({ name, why: '组名不能含斜杠（会被当成通道前缀）' });
      continue;
    }
    if (seen.has(name)) { dropped.push({ name, why: '重名（先出现的生效）' }); continue; }
    const members = [];
    const rawMembers = item && Array.isArray(item.members) ? item.members : [];
    for (const m of rawMembers) {
      const s = String(m == null ? '' : m).trim();
      if (!s) continue;
      if (!members.includes(s)) members.push(s);
    }
    if (!members.length) { dropped.push({ name, why: 'members 为空' }); continue; }
    if (members.length > MAX_MEMBERS) { dropped.push({ name, why: `members 超过 ${MAX_MEMBERS} 个` }); continue; }
    seen.add(name);
    out.push({ name, members });
  }
  // 第二遍：成员不能是组名（自身或其它组），否则会成环
  const names = new Set(out.map((g) => g.name));
  const clean = [];
  for (const g of out) {
    const bad = g.members.find((m) => names.has(m));
    if (bad) { dropped.push({ name: g.name, why: `成员「${bad}」也是一个组名（会成环）` }); continue; }
    clean.push(g);
  }
  return { groups: clean, dropped };
}

let cache = { mtime: -1, data: { groups: [], dropped: [] } };

function Load() {
  let mtime = 0;
  try { mtime = fs.statSync(filePath()).mtimeMs; } catch (e) { /* 没有文件 = 没有组 */ }
  if (cache.mtime === mtime) return { groups: cache.data.groups.map((g) => ({ ...g, members: [...g.members] })), dropped: [...cache.data.dropped] };
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(filePath(), 'utf8')); } catch (e) { raw = null; }
  cache = { mtime, data: raw ? sanitize(raw) : { groups: [], dropped: [] } };
  return { groups: cache.data.groups.map((g) => ({ ...g, members: [...g.members] })), dropped: [...cache.data.dropped] };
}

/** 组名 → 计划（未命中返回 null）。大小写敏感：模型名一直是敏感的。 */
function plan(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return null;
  const { groups } = Load();
  const hit = groups.find((g) => g.name === n);
  return hit ? { name: hit.name, members: [...hit.members] } : null;
}

/** 全部组名（给 /v1/models 与管理端列表用） */
function names() {
  return Load().groups.map((g) => g.name);
}

/** 仅供测试：把进程内缓存打回未读状态 */
function _resetForTest() { cache = { mtime: -1, data: { groups: [], dropped: [] } }; }

module.exports = { FILE, MAX_MEMBERS, MAX_NAME, filePath, sanitize, Load, plan, names, _resetForTest };
