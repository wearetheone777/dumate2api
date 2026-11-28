// src/admin/routes/backup.js - 备份分区表（批次十四，qoder-trae-workbuddy-switch 移植）
//
// 需求背景：data/ 下的账号与配置散在十几个文件里，换机/灾备需要「尽可能多地
// 带走、且明确带走的是什么」。参考实现的定案（backup_sections.rs / export_import.rs）：
//
// - **表驱动（一行 = 一个可备份类型）**：导出勾选、导入合并读**同一张表**——
//   新增可备份类型 = 加一行，导出与导入不会各写一份（那正是本仓反复踩的
//   「两套实现漂移」）。表本体只有一份（SECTION_TABLE），编排只认「遍历分区表」。
// - **merge 纯内存、write 分开**：预览要求只读不写盘（安全阀）——若 merge 自己
//   落盘，预览就会真的改数据。所以「算」（mergeSection 返回合并结果与计数）与
//   「写」（writeSection）拆开：预览只 merge 到副本上丢弃；导入才落盘。
// - **SectionCounts{added,overwritten,skipped,conflicts} 逐分区回报**：预览与
//   结果同源（conflicts 在本期批量策略下恒 0，列表留给逐条裁决的将来）。
// - **导出默认不含凭据**：账号记录脱敏（token/cookie 剥掉、分区标 redacted）；
//   明文出网必须显式 includeCredentials + confirm（前端二次确认，服务端再强制
//   一次——curl 绕不过确认框，但至少把「明文落进导出文件」做成显式双步）。
//   keys.json 整个就是凭据，sensitive 分区不勾「含凭据」直接拒绝导出。
//
// 与参考实现的两处**刻意偏离**（都记进 docs/CHANNEL-WORKBUDDY.md 11.15）：
// 1. 参考按「产品 × region」分作用域（三产品两两套端点）；本项目是单网关五通道，
//    作用域就是分区本身——每通道一行，没有 scope 维度。
// 2. **脱敏记录覆盖本地时保留本地凭据字段**（参考实现整体替换会把 token 一起冲掉）：
//    导入一份不含凭据的备份不该把账号弄成不可用——「没带」与「带了个空」要区分。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendJSON } = require('../router');

const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', '..', 'data');

// ---------------------------------------------------------------------------
// 分区表本体（唯一）：导出勾选、导入合并、GET /sections 列表都从它读
// ---------------------------------------------------------------------------

/**
 * kind = 'accounts'：数组分区，按 identity 键逐条合并（凭据字段 creds 导出默认剥掉）。
 *   存储走各通道 auth 模块的 load/save（mtime 缓存 + 文件锁 + 权限收紧都由它管）。
 * kind = 'object'：对象分区，按顶层键合并（不递归——递归会制造「半新半旧」的中间态）。
 * sensitive = true：整个分区是凭据或可离线爆破的口令哈希，必须显式含凭据才能导出。
 */
const SECTION_TABLE = [
  // —— 账号（数组分区）——
  { id: 'accounts-workbuddy', label: 'WorkBuddy 账号', kind: 'accounts', file: 'workbuddy-accounts.json', store: '../../workbuddy/auth', identity: ['uid', 'id'], creds: ['accessToken', 'refreshToken'] },
  { id: 'accounts-qoder', label: 'Qoder 账号', kind: 'accounts', file: 'qoder-accounts.json', store: '../../qoder/auth', identity: ['uid', 'id'], creds: ['accessToken', 'refreshToken'] },
  { id: 'accounts-traework', label: 'TRAE Work 账号', kind: 'accounts', file: 'traework-accounts.json', store: '../../traework/auth', identity: ['uid', 'id'], creds: ['accessToken', 'refreshToken'] },
  { id: 'accounts-qwenwork', label: '千问办公账号', kind: 'accounts', file: 'qwenwork-accounts.json', store: '../../qwenwork/auth', identity: ['uid', 'id'], creds: ['accessToken', 'refreshToken'] },
  { id: 'accounts-web', label: '搭子网页账号', kind: 'accounts', file: 'web-accounts.json', store: '../../accounts', identity: ['uid', 'id'], creds: ['cookie'] },
  // —— 配置（对象分区）——
  { id: 'model-map', label: '模型映射', kind: 'object', file: 'model-map.json' },
  { id: 'livecfg', label: '热配置（风控/图片预算等）', kind: 'object', file: 'livecfg.json' },
  { id: 'runtime-traework', label: 'TRAE 运行期配置', kind: 'object', file: 'traework-runtime.json' },
  { id: 'runtime-qoder', label: 'Qoder 运行期配置', kind: 'object', file: 'qoder-runtime.json' },
  { id: 'runtime-workbuddy', label: 'WorkBuddy 运行期配置', kind: 'object', file: 'workbuddy-runtime.json' },
  { id: 'model-rules', label: 'WorkBuddy 模型规则', kind: 'object', file: 'workbuddy-model-rules.json' },
  { id: 'auto-checkin', label: '自动签到/任务配置', kind: 'object', file: 'auto-checkin.json' },
  { id: 'task-scheduler', label: '任务轮询配置', kind: 'object', file: 'task-scheduler.json' },
  // —— 敏感（明文凭据 / 可离线爆破的哈希）——
  { id: 'keys', label: 'API Key（明文）', kind: 'object', file: 'keys.json', sensitive: true },
  { id: 'admin-users', label: '管理端账户（口令哈希）', kind: 'object', file: 'admin-users.json', sensitive: true },
];

function sectionById(id) {
  return SECTION_TABLE.find((s) => s.id === id) || null;
}

// ---------------------------------------------------------------------------
// 冲突策略（fail-closed：未知拼写报错，绝不静默回落——回落会让「覆盖」被
// 当成「保留本地」或反过来，用户以为覆盖了其实没覆盖）
// ---------------------------------------------------------------------------

const POLICIES = {
  '': 'keepLocal',           // 空 ⇒ 安全默认（D16）
  keeplocal: 'keepLocal',
  overwrite: 'overwrite',
  keepboth: 'keepBoth',
  ask: 'keepLocal',          // 本期无逐条裁决 UI，真收到按保留本地（参考实现同款）
};

function parseConflictPolicy(raw) {
  const key = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  const policy = POLICIES[key];
  if (!policy) {
    const e = new Error(`未知的冲突策略「${raw}」：合法取值为 keepLocal / overwrite / keepBoth`);
    e.statusCode = 400;
    throw e;
  }
  return policy;
}

// ---------------------------------------------------------------------------
// 读 / 写（accounts 走模块 load/save，object 走原子文件读写）
// ---------------------------------------------------------------------------

function storeOf(spec) {
  return require(spec.store);
}

function readObjectFile(file) {
  // 缺失 / 不可读 / 非法 JSON 一律给 null（不报错）——备份是「尽可能多地带走」，
  // 某个分区文件缺失不该让整份导出失败，缺失即空。
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeObjectFile(file, data) {
  const target = path.join(DATA_DIR, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, target); // 原子写（本仓铁律：直接 writeFileSync 中途被杀留半个 JSON）
}

/** 读一个分区（accounts 返回记录数组；object 返回文件内容，缺失为 null） */
function readSection(spec) {
  if (spec.kind === 'accounts') {
    const data = storeOf(spec).load();
    return Array.isArray(data && data.accounts) ? data.accounts : [];
  }
  return readObjectFile(spec.file);
}

/** 把合并后的分区数据落盘（accounts 先读回容器、只替换 accounts 字段——将来
 *  容器上加字段时不会被字面重建清空，参考实现 Trae 不变式 I-1 的教训） */
function writeSection(spec, merged) {
  if (spec.kind === 'accounts') {
    const mod = storeOf(spec);
    const container = mod.load();
    container.accounts = Array.isArray(merged) ? merged : [];
    mod.save(container);
    return;
  }
  writeObjectFile(spec.file, merged === null || merged === undefined ? {} : merged);
}

// ---------------------------------------------------------------------------
// 脱敏与合并（唯一实现：预览与导入都从这里取）
// ---------------------------------------------------------------------------

/** 剥掉一条账号记录的凭据字段（导出不含凭据用） */
function redactRecord(spec, record) {
  const out = { ...record };
  for (const f of spec.creds || []) delete out[f];
  return out;
}

/** 记录的身份值（identity 键按序取第一个非空；都没有返回 null = 无法配对，只能追加） */
function identityOf(spec, record) {
  for (const k of spec.identity || []) {
    if (record && record[k] !== undefined && record[k] !== null && record[k] !== '') {
      return String(record[k]);
    }
  }
  return null;
}

/** 本地记录里是否已有这个 id（keepBoth 重赋 id / 缺 id 补 id 都要用） */
function idTaken(records, id) {
  return records.some((r) => r && r.id !== undefined && String(r.id) === String(id));
}

function nextId(records) {
  let max = 0;
  for (const r of records) {
    const n = Number(r && r.id);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * 账号分区合并（纯内存）：逐条按身份键配对，依策略处置。
 * 返回 { records, counts, conflicts }。
 *
 * 偏离参考实现的一点：**脱敏记录覆盖本地时保留本地凭据字段**。incoming 没有
 * 凭据字段（redacted 分区导出来的）时，整体替换会把本地 token 一起冲掉——
 * 「这份备份没带凭据」不是「这个账号没有凭据」。incoming 带了凭据才整条覆盖。
 */
function mergeAccountsRecords(spec, localRecords, incomingRecords, policy, redacted) {
  const merged = (Array.isArray(localRecords) ? localRecords : []).map((r) => ({ ...r }));
  const counts = { added: 0, overwritten: 0, skipped: 0, conflicts: 0 };
  const conflicts = [];
  const incoming = Array.isArray(incomingRecords) ? incomingRecords : [];

  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') { counts.skipped++; continue; }
    const item = { ...raw };
    const ident = identityOf(spec, item);
    const index = ident === null ? -1 : merged.findIndex((r) => identityOf(spec, r) === ident);

    if (index < 0) {
      // 追加：无 id / id 撞车时赋新 id（id 是删除 / 列表 key 的依据，不允许无 id 记录）
      if (item.id === undefined || item.id === null || item.id === '' || idTaken(merged, item.id)) {
        item.id = nextId(merged);
      }
      merged.push(item);
      counts.added++;
      continue;
    }

    // 命中同身份：本期批量策略无逐条裁决，conflicts 只计数不阻断
    counts.conflicts++;
    conflicts.push(ident);

    if (policy === 'keepLocal') {
      counts.skipped++;
      continue;
    }
    if (policy === 'keepBoth') {
      const appended = { ...item };
      if (appended.id === undefined || appended.id === null || appended.id === '' || idTaken(merged, appended.id)) {
        appended.id = nextId(merged);
      }
      merged.push(appended);
      counts.added++; // KeepBoth 会「增行」：计入新增（参考实现同款）
      continue;
    }
    // overwrite：脱敏来件（或这条没带凭据）保留本地凭据字段——
    // 「这份备份没带凭据」不是「这个账号没有凭据」
    const incomingHasCreds = (spec.creds || []).some((f) => item[f] !== undefined);
    if (!incomingHasCreds) {
      for (const f of spec.creds || []) {
        if (item[f] === undefined && merged[index][f] !== undefined) item[f] = merged[index][f];
      }
    }
    if (item.id === undefined || item.id === null || item.id === '') {
      item.id = merged[index].id; // 缺 id 保留本地 id（账号库不允许无 id 记录）
    }
    merged[index] = item;
    counts.overwritten++;
  }
  return { merged, counts, conflicts };
}

/**
 * 对象分区合并（纯内存）：按顶层键合并（本地没有 ⇒ added；有 ⇒ 依策略）。
 * 只做顶层键：配置都是「一组子对象」，逐子对象整体替换即可，不递归到叶子。
 */
function mergeObjectSection(localData, incomingData, policy) {
  const counts = { added: 0, overwritten: 0, skipped: 0, conflicts: 0 };
  const conflicts = [];
  const base = (localData && typeof localData === 'object' && !Array.isArray(localData))
    ? { ...localData } : {};
  if (!incomingData || typeof incomingData !== 'object' || Array.isArray(incomingData)) {
    return { merged: base, counts, conflicts }; // 来件不是对象 = 该分区没带东西，原样保留
  }
  for (const key of Object.keys(incomingData)) {
    if (key in base) {
      if (policy === 'overwrite') { base[key] = incomingData[key]; counts.overwritten++; }
      else { counts.skipped++; conflicts.push(key); counts.conflicts++; }
    } else {
      base[key] = incomingData[key];
      counts.added++;
    }
  }
  return { merged: base, counts, conflicts };
}

/** 合并一个分区（accounts/object 共用入口，预览与导入的唯一实现） */
function mergeSection(spec, localData, incomingData, policy, redacted) {
  if (spec.kind === 'accounts') {
    return mergeAccountsRecords(spec, localData, incomingData, policy, redacted);
  }
  return mergeObjectSection(localData, incomingData, policy);
}

// ---------------------------------------------------------------------------
// 导出（信封）
// ---------------------------------------------------------------------------

function buildEnvelope(specs, { includeCredentials }) {
  const sections = {};
  for (const spec of specs) {
    const data = readSection(spec);
    if (spec.kind === 'accounts') {
      if (!includeCredentials) {
        sections[spec.id] = { data: (Array.isArray(data) ? data : []).map((r) => redactRecord(spec, r)), redacted: true };
      } else {
        sections[spec.id] = { data: Array.isArray(data) ? data : [], redacted: false };
      }
    } else {
      sections[spec.id] = { data, redacted: false };
    }
  }
  return {
    format: 'dumate2api-backup',
    version: 1,
    app: 'dumate2api',
    generatedAt: new Date().toISOString(),
    includeCredentials: !!includeCredentials,
    sections,
  };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const routes = [
  {
    method: 'GET',
    path: '/sections',
    handler: async ({ res }) => {
      const rows = SECTION_TABLE.map((spec) => {
        let exists = false;
        let count = 0;
        let updatedAt = null;
        try {
          const st = fs.statSync(path.join(DATA_DIR, spec.file));
          exists = true;
          updatedAt = st.mtimeMs;
          const data = readSection(spec);
          count = spec.kind === 'accounts' ? (Array.isArray(data) ? data.length : 0)
            : (data && typeof data === 'object' ? Object.keys(data).length : 0);
        } catch (e) { /* 文件不存在：exists=false，count=0 */ }
        return { id: spec.id, label: spec.label, kind: spec.kind, sensitive: !!spec.sensitive, exists, count, updatedAt };
      });
      return sendJSON(res, 200, { ok: true, sections: rows });
    },
  },
  {
    // 导出。明文出网是双确认：前端二次确认 + 这里显式 includeCredentials+confirm。
    method: 'POST',
    path: '/export',
    handler: async ({ res, body, user }) => {
      const specs = [];
      const wanted = Array.isArray(body && body.sections) ? body.sections : [];
      const unknown = [];
      for (const id of wanted) {
        const spec = sectionById(String(id));
        if (!spec) { unknown.push(id); continue; }
        specs.push(spec);
      }
      if (unknown.length) {
        return sendJSON(res, 400, { ok: false, error: `未知分区: ${unknown.join(', ')}` });
      }
      if (!specs.length) {
        return sendJSON(res, 400, { ok: false, error: '至少选择一个分区' });
      }
      const includeCredentials = !!(body && body.includeCredentials);
      const sensitive = specs.filter((s) => s.sensitive);
      if (sensitive.length && !includeCredentials) {
        return sendJSON(res, 400, {
          ok: false,
          error: `${sensitive.map((s) => s.id).join(', ')} 是凭据分区：不勾「含凭据」就不能导出（整个文件就是明文凭证 / 可离线爆破的哈希）`,
        });
      }
      if (includeCredentials && !(body && body.confirm)) {
        return sendJSON(res, 400, { ok: false, error: '含凭据导出必须 confirm: true（明文出网是显式动作，不接受默认发生）' });
      }
      const envelope = buildEnvelope(specs, { includeCredentials });
      try { require('../auth').audit(user && user.username, 'backup_export', wanted.join(','), includeCredentials ? '含凭据' : '脱敏'); } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, { ok: true, envelope });
    },
  },
  {
    // 导入预览：与导入同一份 merge 实现，只算不写（零写盘是安全阀）。
    method: 'POST',
    path: '/preview',
    handler: async ({ res, body }) => {
      return runMerge(res, body, { write: false });
    },
  },
  {
    method: 'POST',
    path: '/import',
    handler: async ({ res, body, user }) => {
      const out = await runMerge(res, body, { write: true });
      if (out && out.ok) {
        try { require('../auth').audit(user && user.username, 'backup_import', Object.keys(out.results || {}).join(','), `policy=${(body && body.policy) || 'keepLocal'}`); } catch (e) { /* 审计失败不影响结果 */ }
      }
      return out;
    },
  },
];

/** 预览 / 导入共用编排：解信封 → 逐分区 merge（write=false 只算不写）→ 逐分区回报 */
async function runMerge(res, body, { write }) {
  const envelope = body && body.envelope;
  if (!envelope || envelope.format !== 'dumate2api-backup' || envelope.version !== 1) {
    return sendJSON(res, 400, { ok: false, error: '信封不合法：需要 dumate2api-backup / version 1' });
  }
  if (!envelope.sections || typeof envelope.sections !== 'object') {
    return sendJSON(res, 400, { ok: false, error: '信封缺少 sections' });
  }
  let policy;
  try { policy = parseConflictPolicy(body && body.policy); } catch (e) {
    return sendJSON(res, e.statusCode || 400, { ok: false, error: e.message });
  }
  // 要处理的分区 = 信封里有的 ∩（调用方点名 || 全部）。信封里不认识的 id 跳过并
  // 如实回报（前向兼容：新版本加的分区，旧版导入器不猜它的语义）。
  const wanted = Array.isArray(body && body.sections) ? body.sections.map(String) : null;
  const ignored = [];
  const specs = [];
  for (const id of Object.keys(envelope.sections)) {
    const spec = sectionById(id);
    if (!spec) { ignored.push(id); continue; }
    if (wanted && !wanted.includes(id)) continue;
    specs.push(spec);
  }
  if (wanted) {
    const missing = wanted.filter((id) => !sectionById(id) && !ignored.includes(id));
    if (missing.length) ignored.push(...missing);
  }
  if (!specs.length) {
    return sendJSON(res, 400, { ok: false, error: '信封里没有可导入的分区' });
  }

  const results = {};
  for (const spec of specs) {
    const incoming = envelope.sections[spec.id];
    const redacted = !!(incoming && incoming.redacted);
    let data = incoming && incoming.data;
    if (spec.kind === 'accounts' && !Array.isArray(data)) {
      results[spec.id] = { ok: false, error: '分区数据不是记录数组，跳过', counts: { added: 0, overwritten: 0, skipped: 0, conflicts: 0 } };
      continue;
    }
    if (spec.kind === 'object' && (data === null || data === undefined)) {
      results[spec.id] = { ok: false, error: '源备份里没有该分区数据（导出时文件缺失），跳过', counts: { added: 0, overwritten: 0, skipped: 0, conflicts: 0 } };
      continue;
    }
    const local = readSection(spec);
    const { merged, counts, conflicts } = mergeSection(spec, local, data, policy, redacted);
    if (write) writeSection(spec, merged);
    // conflicts 键名在 counts 里已被数值占用，身份/键名清单以 conflictKeys 并列回报
    results[spec.id] = { ok: true, ...counts, conflictKeys: conflicts };
  }
  return sendJSON(res, 200, {
    ok: true,
    policy,
    write: !!write,
    results,
    ignored: ignored.length ? ignored : undefined,
  });
}

module.exports = { routes, SECTION_TABLE, parseConflictPolicy, mergeSection, mergeAccountsRecords, mergeObjectSection, redactRecord, buildEnvelope, _dataDir: () => DATA_DIR };
