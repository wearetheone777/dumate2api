// src/workbuddy/rules.js - 「模型规则」：按规则批量控制哪些账号能用哪些模型（批次十二，misakano modelrules.go 移植）
//
// 需求背景：昂贵模型只对少数账号开放，其余账号只用便宜常用的模型——否则一个
// 账号把自己的额度打穿，整个池子连便宜模型都跟着没得用。
//
// 与逐条 modelOff 的关系：规则是**命名的一组模型 + 黑/白模式**，挂到账号上即刻
// 生效，改规则内容时所有挂了它的账号一起变（不用逐个账号重设）。
//
// 语义（modelrules.go 原文口径）：
//   deny  黑名单：规则里的模型不可用；
//   allow 白名单：只有规则里的模型可用，列表外的全部不可用。
// 一个账号可挂多条：多条 deny 取并集；多条 allow 取并集；同时存在时 **deny 优先**
// （显式禁用比允许列表更明确）。
//
// 域前缀：规则里的模型名可带 cn:/global: 前缀（cn:hy4std 与 global:hy4std 走两套
// 上游两拨账号，剥掉就分不开）；裸名 = 两个域都命中。一条 allow 规则若在账号所属
// 域**一个模型都没命中**（典型：global 号挂了纯 cn: 白名单），视作这条规则没挂
// ——否则这个号会被白名单封死所有模型，而面板上它看起来毫无异常。跨域写错规则的
// 意图几乎必然是「这个号只用这几个模型」，不是「这个号什么都不能用」。
//
// 存储：data/workbuddy-model-rules.json（原子写，mtime 热读——与 modelmap/keys
// 同款：管理端改完网关立即生效，不需要重启）。规则与「账号 → 规则 id」都进这一
// 个文件，凭证（workbuddy-accounts.json）不掺配置。
'use strict';
const fs = require('fs');
const path = require('path');
const c = require('./constants');

const FILE = 'workbuddy-model-rules.json';
const RULE_MODES = {
  deny: 'deny', blacklist: 'deny', black: 'deny',
  allow: 'allow', whitelist: 'allow', white: 'allow',
};

// mtime 缓存：规则文件被管理端写后网关侧零重启生效
let cache = { mtime: -1, data: null };

function filePath() {
  const dir = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
  return path.join(dir, FILE);
}

function emptyStore() { return { rules: {}, assignments: {} }; }

function load() {
  try {
    const st = fs.statSync(filePath());
    const mtime = st.mtimeMs;
    if (cache.data && mtime === cache.mtime) return cache.data;
    const j = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    const data = {
      rules: (j && j.rules && typeof j.rules === 'object') ? j.rules : {},
      assignments: (j && j.assignments && typeof j.assignments === 'object') ? j.assignments : {},
    };
    cache = { mtime, data };
    return data;
  } catch (e) {
    // 文件不存在 = 没有任何规则（不缓存负态：写入靠 save 直接落盘）
    return emptyStore();
  }
}

function save(data) {
  const p = filePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, p);
  cache = { mtime: -1, data: null }; // 下次 load 按 mtime 重读
}

function newRuleID() {
  try {
    return require('crypto').randomBytes(6).toString('hex');
  } catch (e) {
    return `r${Date.now()}`; // 随机源不可用退回时间戳，宁可碰撞也不炸
  }
}

/** 归一化模型名：去空白、小写；**保留域前缀**（前缀是区分依据） */
function normalizeRuleModel(m) {
  return String(m || '').toLowerCase().trim();
}

/** cn:hy4std → ('cn','hy4std')；无前缀 → ('', 裸名) */
function splitRealmModel(m) {
  const s = String(m || '');
  const i = s.indexOf(':');
  if (i >= 0) return [s.slice(0, i).toLowerCase(), s.slice(i + 1)];
  return ['', s];
}

/** 校验并归一化一条规则（写入口统一走这里）。返回 {rule?, error?} */
function normalizeRule(input) {
  const out = { ...(input && typeof input === 'object' ? input : {}) };
  out.name = String(out.name || '').trim();
  if (!out.name) return { error: '规则名不能为空' };
  if ([...out.name].length > 40) return { error: '规则名最长 40 字' };
  const mode = RULE_MODES[String(out.mode || '').toLowerCase().trim()];
  if (!mode) return { error: '模式只能是 deny（禁用）或 allow（只允许）' };
  out.mode = mode;
  const seen = new Set();
  const models = [];
  for (const m of Array.isArray(out.models) ? out.models : []) {
    const n = normalizeRuleModel(m);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    models.push(n);
  }
  if (!models.length) return { error: '至少要勾选一个模型' };
  models.sort();
  out.models = models;
  out.note = String(out.note || '').trim();
  out.updatedAt = new Date().toISOString();
  if (out.id != null) out.id = String(out.id).trim();
  return { rule: out };
}

// ---- CRUD（管理端消费） ------------------------------------------------

/** 全部规则（按 name、id 排序，输出稳定） */
function listRules() {
  const { rules } = load();
  return Object.values(rules)
    .sort((a, b) => (a.name !== b.name ? (a.name < b.name ? -1 : 1) : String(a.id).localeCompare(String(b.id))));
}

function getRule(id) {
  return load().rules[String(id || '').trim()] || null;
}

/** 新建（id 空）或更新。带 id 更新时规则必须已存在——拼错 id 悄悄建出一条没人挂的新规则最难排查 */
function upsertRule(input) {
  const { rule, error } = normalizeRule(input);
  if (error) throw Object.assign(new Error(error), { statusCode: 400 });
  const data = load();
  if (!rule.id) {
    rule.id = newRuleID();
  } else if (!data.rules[rule.id]) {
    throw Object.assign(new Error(`规则不存在: ${rule.id}`), { statusCode: 404 });
  }
  data.rules[rule.id] = rule;
  save(data);
  return rule;
}

/** 删除规则并从所有账号上摘掉引用。返回是否真的删了 */
function deleteRule(id) {
  const key = String(id || '').trim();
  const data = load();
  if (!data.rules[key]) return false;
  delete data.rules[key];
  for (const accId of Object.keys(data.assignments)) {
    data.assignments[accId] = (data.assignments[accId] || []).filter((x) => x !== key);
    if (!data.assignments[accId].length) delete data.assignments[accId];
  }
  save(data);
  return true;
}

/** 设置某账号挂的规则集合（整体替换）。未知规则 id 拒绝，避免野 id 静默进账 */
function assignRules(accountId, ids) {
  const data = load();
  const key = String(accountId);
  const want = [];
  const seen = new Set();
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) continue;
    if (!data.rules[id]) throw Object.assign(new Error(`规则不存在: ${id}`), { statusCode: 404 });
    seen.add(id);
    want.push(id);
  }
  want.sort();
  if (want.length) data.assignments[key] = want;
  else delete data.assignments[key]; // 全摘掉 = 不留空数组行
  save(data);
  return want;
}

/** 把一条规则批量挂/摘（只增删这一条，账号原有的其它规则原样保留）。
 *  返回真正发生变化的账号数；规则 id 不存在报错。 */
function applyRule(id, accountIds, assigned) {
  const key = String(id || '').trim();
  const data = load();
  if (!data.rules[key]) throw Object.assign(new Error(`规则不存在: ${key}`), { statusCode: 404 });
  let changed = 0;
  for (const raw of Array.isArray(accountIds) ? accountIds : []) {
    const accKey = String(raw);
    const cur = data.assignments[accKey] || [];
    const has = cur.includes(key);
    if (has === !!assigned) continue; // 已是想要的状态，不计入变化
    const next = assigned ? [...cur, key] : cur.filter((x) => x !== key);
    next.sort();
    data.assignments[accKey] = next;
    changed++;
  }
  if (changed) {
    // 清掉摘空的
    for (const accKey of Object.keys(data.assignments)) {
      if (!data.assignments[accKey].length) delete data.assignments[accKey];
    }
    save(data);
  }
  return changed;
}

function ruleIdsOf(accountId) {
  return [...(load().assignments[String(accountId)] || [])];
}

/** 每条规则被多少账号挂着（列表展示用） */
function ruleAccountCounts() {
  const { assignments } = load();
  const out = {};
  for (const ids of Object.values(assignments)) {
    for (const id of ids) out[id] = (out[id] || 0) + 1;
  }
  return out;
}

/** 账号 id → 挂着的规则 id 全量映射 */
function ruleAssignments() {
  const { assignments } = load();
  const out = {};
  for (const [k, v] of Object.entries(assignments)) {
    if (v && v.length) out[k] = [...v];
  }
  return out;
}

// ---- 运行期判定（send 选号链消费） --------------------------------------

/** 把一个账号挂的规则展开成快查集合。region 是**账号自己的域**。
 *  只展开已装载的规则：真删除时由 deleteRule 摘引用，这里不剔除残留 id。 */
function expandFor(accountId, region) {
  const data = load();
  const ids = data.assignments[String(accountId)] || [];
  const realm = region ? c.normalizeRegion(region) : '';
  const deny = new Set();
  const allow = new Set();
  let hasAllow = false;
  for (const id of ids) {
    const r = data.rules[id];
    if (!r) continue;
    if (r.mode === 'allow') {
      // 先按域收一遍：本域一个都没命中 → 这条规则视作没挂（防跨域误挂封死）
      const matched = new Set();
      for (const m of r.models || []) {
        const [rm, bare] = splitRealmModel(m);
        if (rm && realm && rm !== realm) continue;
        if (bare) matched.add(bare);
      }
      if (!matched.size) continue;
      hasAllow = true;
      for (const m of matched) allow.add(m);
      continue;
    }
    for (const m of r.models || []) {
      const [rm, bare] = splitRealmModel(m);
      if (rm && realm && rm !== realm) continue;
      if (bare) deny.add(bare);
    }
  }
  return { deny, allow, hasAllow };
}

/** 集合命中（入参可能是裸名或带域前缀：选号链路传裸名，排查链路可能带前缀） */
function setHas(set, model) {
  if (set.has(model)) return true;
  const i = model.indexOf(':');
  return i >= 0 ? set.has(model.slice(i + 1)) : false;
}

/** 该账号对该模型是否被规则拦住。空模型 / 'auto'（档位由账号决定）不做模型级判断 */
function blockedByRules(accountId, region, model) {
  const m = normalizeRuleModel(model);
  if (!m || m === 'auto') return false;
  const { deny, allow, hasAllow } = expandFor(accountId, region);
  const bare = splitRealmModel(m)[1];
  if (hasAllow && !setHas(allow, bare)) return true; // 白名单之外
  if (setHas(deny, bare)) return true;               // 显式禁用优先
  return false;
}

/**
 * 从候选里剔掉被规则拦住的账号。region 只用于缺省展开（账号自己的域才是比对基准）。
 * 返回 {kept, blockedCount, blockedIds}——调用方据此在「全拦」时回可辨识的 4xx。
 */
function filterAccounts(accounts, region, model) {
  const m = normalizeRuleModel(model);
  if (!m || m === 'auto') return { kept: Array.isArray(accounts) ? [...accounts] : [], blockedCount: 0, blockedIds: [] };
  const kept = [];
  const blockedIds = [];
  for (const a of Array.isArray(accounts) ? accounts : []) {
    if (!a || a.id === undefined) continue;
    if (blockedByRules(a.id, (a && a.region) || region || '', m)) blockedIds.push(a.id);
    else kept.push(a);
  }
  return { kept, blockedCount: blockedIds.length, blockedIds };
}

module.exports = {
  listRules, getRule, upsertRule, deleteRule, assignRules, applyRule,
  ruleIdsOf, ruleAccountCounts, ruleAssignments,
  blockedByRules, filterAccounts, expandFor,
  normalizeRuleModel, splitRealmModel, normalizeRule,
  _filePath: filePath, _load: load,
};
