// src/account-transfer.js - 跨通道账号导入 / 导出
//
// 定位：把「换机、重装、多实例之间搬账号」从「手工复制 data/*-accounts.json」
// 变成一个可校验、可审计、可回退的动作。
//
// 为什么不让用户直接拷 JSON 文件：五个通道的账号文件形状各不相同（搭子是
// cookie 明文，四条直连通道是 access/refresh token + 设备指纹），直接拷文件
// 有两个后果——
//   1. **id 会撞**：源机器的 id 是它自己的自增序号，拷到目标机器上会和别的
//      账号抢同一个 id，于是 `patch(id)` / `remove(id)` 改到别人的号上；
//   2. **运行时字段会一起过来**：lastError / 冷却 / 签到缓存属于源机器此刻的
//      状态，搬过去只会让人把一条早已自愈的错误当成当前故障。
// 所以这里统一走「白名单字段 + 按业务键 upsert」，id 一律重新分配。
//
// 三条纪律：
//   1. **导出含明文凭证**（cookie / refresh token）。这是迁移的必要条件，
//      所以接口只给 admin，响应带 no-store + attachment，动作落审计。
//   2. **导入只认白名单字段**。整条记录 Object.assign 进账号文件等于允许
//      调用方写任意字段（含 `__proto__`），白名单是唯一可靠的边界。
//   3. **单条坏记录不中断整包**。逐条记结果（created/updated/skipped/failed），
//      失败的带上原因——「导入 30 个成功 2 个」必须能指出是哪 2 个。
//
// 冲突策略只有两种，且都要显式传：
//   skip（默认）—— 已存在的不动，只补新号；
//   overwrite   —— 已存在的替换凭证（迁移时源机器换了 token 才用）。
const CH = require('./channels');
const accounts = require('./accounts');
const qwenworkAuth = require('./qwenwork/auth');
const traeworkAuth = require('./traework/auth');
const qoderAuth = require('./qoder/auth');
const workbuddyAuth = require('./workbuddy/auth');
const traeworkConstants = require('./traework/constants');
const qoderConstants = require('./qoder/constants');
const workbuddyConstants = require('./workbuddy/constants');

const KIND = 'dumate2api-accounts';
const VERSION = 1;
const MAX_ERRORS = 50;

/**
 * 每个通道可导入的字段白名单。
 *
 * **这是唯一的安全边界**：不在这里的字段一律不落盘。新增账号字段时要同步
 * 加进来，否则「导出有、导入丢」——迁移过去后账号能用但少个标记，很难归因。
 * `id` / `lastError` / `lastErrorAt` 刻意不在表内（见文件头两条理由）。
 */
const FIELDS = {
  dumate: ['name', 'cookie', 'enabled', 'proxy', 'uid', 'nickname'],
  qwenwork: ['uid', 'nickname', 'username', 'email', 'tier', 'planId', 'planName', 'phone',
    'accessToken', 'refreshToken', 'expiresAt', 'refreshExpiresAt', 'machineId',
    'enabled', 'preferred', 'proxy'],
  traework: ['uid', 'nickname', 'email', 'region', 'accessToken', 'refreshToken',
    'expiresAt', 'refreshExpiresAt', 'deviceId', 'sessionId', 'marketUserId',
    'deviceDerivedFrom', 'deviceGeneration', 'machineId', 'apiHost',
    'phone', 'phoneSource', 'enabled', 'modelEnabled', 'group', 'proxy'],
  qoder: ['uid', 'nickname', 'username', 'email', 'phone', 'region', 'userType', 'planName',
    'accessToken', 'refreshToken', 'expiresAt', 'refreshExpiresAt',
    'machineId', 'machineToken', 'machineType', 'enabled', 'preferred', 'proxy'],
  workbuddy: ['uid', 'region', 'nickname', 'email', 'enterpriseId', 'enterpriseName', 'domain',
    'accessToken', 'refreshToken', 'expiresAt', 'refreshExpiresAt', 'source',
    'enabled', 'preferred', 'group', 'proxy'],
};

/** 没有这些字段的账号导入进去也发不出请求——逐条拒掉并说明缺哪个 */
const REQUIRED = {
  dumate: ['cookie'],
  qwenwork: ['uid', 'accessToken', 'refreshToken'],
  traework: ['uid', 'accessToken', 'refreshToken'],
  qoder: ['uid', 'accessToken', 'refreshToken'],
  workbuddy: ['uid', 'accessToken', 'refreshToken'],
};

/** 有区域概念的通道 → 该通道自己的归一化函数（口径必须与账号池一致） */
const REGION_OF = {
  traework: (r) => traeworkConstants.normalizeRegion(r), // cn / intl
  qoder: (r) => qoderConstants.normalizeRegion(r),       // cn / global
  workbuddy: (r) => workbuddyConstants.normalizeRegion(r), // cn / global
};

/** 接口参数里的 intl 要翻成各通道自己的术语（qoder/workbuddy 叫 global） */
function requestRegion(channel, raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return '';
  if (s === 'cn') return 'cn';
  if (s !== 'intl' && s !== 'global') return '';
  return channel === 'traework' ? 'intl' : 'global';
}

function listRaw(channel) {
  switch (channel) {
    case 'dumate': return accounts.load().accounts;
    case 'qwenwork': return qwenworkAuth.load().accounts;
    case 'traework': return traeworkAuth.load().accounts;
    case 'qoder': return qoderAuth.load().accounts;
    case 'workbuddy': return workbuddyAuth.load().accounts;
    default: return [];
  }
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 导出单条：白名单字段 + createdAt（供目标机显示「账号存活天数」） */
function exportOf(channel, a) {
  const out = pick(a, FIELDS[channel]);
  const created = a.createdAt != null ? a.createdAt : a.created_at;
  if (created != null) out.createdAt = created;
  return out;
}

/**
 * 导出。`channel` 为空表示全部通道。
 * 返回统一信封：`{kind, version, exported_at, channels: { <id>: {region, accounts} }}`
 * ——单通道与全通道同一形状，导入端只写一份解析。
 */
function exportPayload({ channel = '', region = '' } = {}) {
  const want = String(channel || '').trim();
  if (want && !CH.CHANNELS.includes(want)) {
    return { ok: false, error: `未知通道: ${want}` };
  }
  const ids = want ? [want] : CH.CHANNELS.slice();
  const out = { kind: KIND, version: VERSION, exported_at: new Date().toISOString(), channels: {} };
  for (const id of ids) {
    const wantRegion = requestRegion(id, region);
    let rows = listRaw(id);
    if (wantRegion && REGION_OF[id]) rows = rows.filter((a) => REGION_OF[id](a.region) === wantRegion);
    out.channels[id] = {
      label: CH.label(id),
      region: wantRegion || '',
      accounts: rows.map((a) => exportOf(id, a)),
    };
  }
  out.note = '本文件含账号明文凭证（cookie / refresh token），按密码级敏感信息保管';
  return { ok: true, payload: out };
}

/** 本地账号概览（不含任何凭证）——界面在导出前显示「本地有几个」 */
function summarize() {
  return CH.CHANNELS.map((id) => {
    const rows = listRaw(id);
    const row = {
      channel: id,
      label: CH.label(id),
      total: rows.length,
      enabled: rows.filter((a) => a.enabled !== false).length,
    };
    if (REGION_OF[id]) {
      const byRegion = {};
      for (const a of rows) {
        const r = REGION_OF[id](a.region);
        byRegion[r] = (byRegion[r] || 0) + 1;
      }
      row.byRegion = byRegion;
    }
    return row;
  });
}

/** 校验单条记录：缺必填字段 / 类型明显不对就拒，不猜 */
function validateOne(channel, rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return '记录不是对象';
  for (const k of REQUIRED[channel]) {
    const v = rec[k];
    if (v === undefined || v === null || String(v).trim() === '') return `缺少 ${k}`;
  }
  return '';
}

/**
 * 导入一个通道的记录。调用方已保证 channel 合法。
 * @param {string} channel
 * @param {Array} rows
 * @param {{mode?: 'skip'|'overwrite', region?: string}} opts
 */
function importChannel(channel, rows, opts = {}) {
  const mode = opts.mode === 'overwrite' ? 'overwrite' : 'skip';
  const fallbackRegion = requestRegion(channel, opts.region);
  const result = {
    channel, label: CH.label(channel), mode,
    received: Array.isArray(rows) ? rows.length : 0,
    created: 0, updated: 0, skipped: 0, failed: 0,
    refreshExpired: 0,
    errors: [],
  };
  const addError = (msg) => {
    result.failed += 1;
    if (result.errors.length < MAX_ERRORS) result.errors.push(msg);
  };
  if (!Array.isArray(rows)) {
    addError('accounts 不是数组');
    return result;
  }

  // 主账号标记的排他处理：目标池已经有主账号就一律不认导入记录里的标记，
  // 否则会留下两个 preferred，选号退化成「看谁排在前面」。
  let hasPreferred = listRaw(channel).some((a) => a && a.preferred);

  rows.forEach((raw, i) => {
    const label = `#${i + 1}`;
    try {
      const bad = validateOne(channel, raw);
      if (bad) { addError(`${label} ${bad}`); return; }

      const rec = pick(raw, FIELDS[channel]);
      if (rec.preferred === true) {
        if (hasPreferred) delete rec.preferred;
        else hasPreferred = true;
      }
      for (const k of ['expiresAt', 'refreshExpiresAt']) {
        if (k in rec) {
          const n = numOrNull(rec[k]);
          if (n === null) delete rec[k]; else rec[k] = n;
        }
      }
      // createdAt 不在 FIELDS 白名单里（它是元数据不是凭证），但迁移时要带走
      // ——目标机用它算「账号存活天数」。校验后并进 rec，让下面统一处理。
      const created = numOrNull(raw && raw.createdAt);
      if (created) rec.createdAt = created;
      // 区域：记录自己的区域优先（那是凭证身份的一部分），缺了才用请求参数，
      // 再缺按国内——与界面默认视图一致，不静默落到 qoder 的 global 默认。
      if (REGION_OF[channel]) {
        rec.region = REGION_OF[channel](rec.region || fallbackRegion || 'cn');
      }
      if (rec.createdAt !== undefined) {
        const c = numOrNull(rec.createdAt);
        if (c) rec.createdAt = c; else delete rec.createdAt;
      }
      // 到期时间已过 = 这个号必须重新登录才能用。如实计数，不当失败——
      // 迁移本身没错，是凭证本身老了。
      if (rec.refreshExpiresAt && Date.now() >= rec.refreshExpiresAt) result.refreshExpired += 1;

      const one = importOne(channel, rec, mode);
      if (one.action === 'created') result.created += 1;
      else if (one.action === 'updated') result.updated += 1;
      else result.skipped += 1;
    } catch (e) {
      addError(`${label} ${e.message}`);
    }
  });
  return result;
}

function importOne(channel, rec, mode) {
  switch (channel) {
    case 'dumate': {
      const cookie = accounts.normalizeCookie(rec.cookie);
      const sum = accounts.cookieSummary(cookie);
      if (!sum.has_bduss) throw new Error('cookie 里没有 BDUSS');
      const existing = accounts.load().accounts
        .find((a) => accounts.cookieSummary(a.cookie).bduss_tail === sum.bduss_tail);
      if (existing) {
        if (mode !== 'overwrite') return { action: 'skipped', id: existing.id };
        accounts.update(existing.id, {
          cookie,
          name: rec.name,
          enabled: rec.enabled,
          proxy: rec.proxy,
        });
        // uid / nickname 只能走 patchInternal（update 只管用户可编辑的三项）
        const patch = {};
        if (rec.uid) patch.uid = rec.uid;
        if (rec.nickname) patch.nickname = rec.nickname;
        if (rec.createdAt) patch.created_at = rec.createdAt;
        if (Object.keys(patch).length) accounts.patchInternal(existing.id, patch);
        return { action: 'updated', id: existing.id };
      }
      const created = accounts.create({
        cookie,
        name: rec.name,
        enabled: rec.enabled,
        proxy: rec.proxy,
      });
      const patch = {};
      if (rec.uid) patch.uid = rec.uid;
      if (rec.nickname) patch.nickname = rec.nickname;
      if (rec.createdAt) patch.created_at = rec.createdAt;
      if (Object.keys(patch).length) accounts.patchInternal(created.id, patch);
      return { action: 'created', id: created.id };
    }
    case 'qwenwork': {
      const existing = qwenworkAuth.load().accounts.find((a) => a.uid && a.uid === rec.uid);
      if (existing && mode !== 'overwrite') return { action: 'skipped', id: existing.id };
      const saved = qwenworkAuth.upsert({ ...rec, lastError: '', lastErrorAt: null });
      return { action: existing ? 'updated' : 'created', id: saved.id };
    }
    case 'traework': {
      // TRAE 的 upsert 按 uid 匹配（与账号池自身一致），设备指纹缺失时
      // ensureDevice 会按 uid 确定性重派生，不需要导出里带齐
      const existing = traeworkAuth.load().accounts.find((a) => a.uid && a.uid === rec.uid);
      if (existing && mode !== 'overwrite') return { action: 'skipped', id: existing.id };
      const saved = traeworkAuth.upsert({ ...rec, lastError: '', lastErrorAt: null });
      return { action: existing ? 'updated' : 'created', id: saved.id };
    }
    case 'qoder': {
      const existing = qoderAuth.load().accounts.find((a) => a.uid && a.uid === rec.uid);
      if (existing && mode !== 'overwrite') return { action: 'skipped', id: existing.id };
      const saved = qoderAuth.upsert({ ...rec, lastError: '', lastErrorAt: null });
      return { action: existing ? 'updated' : 'created', id: saved.id };
    }
    case 'workbuddy': {
      const reg = workbuddyConstants.normalizeRegion(rec.region);
      const existing = workbuddyAuth.load().accounts
        .find((a) => a.uid && a.uid === rec.uid && workbuddyConstants.normalizeRegion(a.region) === reg);
      if (existing && mode !== 'overwrite') return { action: 'skipped', id: existing.id };
      const saved = workbuddyAuth.upsert({ ...rec, region: reg, lastError: '', lastErrorAt: null });
      return { action: existing ? 'updated' : 'created', id: saved.id };
    }
    default:
      throw new Error(`未知通道: ${channel}`);
  }
}

/**
 * 导入入口。接受三种输入形状（都归一化到「通道 → 记录数组」）：
 *   1. 本模块导出的信封 `{kind, channels:{id:{accounts}}}`
 *   2. 单通道对象 `{channel, accounts:[...]}`
 *   3. 裸数组 + 请求里显式给 channel
 * 先整体校验形状再动手：整包形状错（不是对象、version 不支持）一口拒掉，
 * 不做「跳过坏通道继续导」的半导入。
 */
function importPayload(payload, opts = {}) {
  const mode = opts.mode === 'overwrite' ? 'overwrite' : 'skip';
  const explicit = String(opts.channel || '').trim();
  if (explicit && !CH.CHANNELS.includes(explicit)) return { ok: false, error: `未知通道: ${explicit}` };

  let perChannel = null;
  if (Array.isArray(payload)) {
    if (!explicit) return { ok: false, error: '裸数组必须指定 channel' };
    perChannel = { [explicit]: payload };
  } else if (payload && typeof payload === 'object') {
    if (payload.kind && payload.kind !== KIND) {
      return { ok: false, error: `不是账号导出文件（kind=${payload.kind}）` };
    }
    if (payload.version != null && Number(payload.version) > VERSION) {
      return { ok: false, error: `文件版本 ${payload.version} 高于本机支持的 ${VERSION}` };
    }
    if (payload.channels && typeof payload.channels === 'object') {
      perChannel = {};
      for (const [id, v] of Object.entries(payload.channels)) {
        if (!CH.CHANNELS.includes(id)) return { ok: false, error: `未知通道: ${id}` };
        const rows = Array.isArray(v) ? v : (v && Array.isArray(v.accounts) ? v.accounts : null);
        if (!rows) return { ok: false, error: `通道 ${id} 的 accounts 不是数组` };
        perChannel[id] = rows;
      }
    } else if (Array.isArray(payload.accounts)) {
      const id = explicit || String(payload.channel || '').trim();
      if (!CH.CHANNELS.includes(id)) return { ok: false, error: '缺少或未知的 channel' };
      perChannel = { [id]: payload.accounts };
    } else {
      return { ok: false, error: '缺少 channels / accounts' };
    }
  } else {
    return { ok: false, error: '导入体不是对象' };
  }

  const ids = Object.keys(perChannel);
  if (!ids.length) return { ok: false, error: '导入体里没有任何通道' };
  if (explicit && ids.some((id) => id !== explicit)) {
    return { ok: false, error: `文件含 ${ids.join('/')}，与指定的 channel=${explicit} 不一致` };
  }

  const results = ids.map((id) => importChannel(id, perChannel[id], {
    mode,
    region: opts.region,
  }));
  const totals = results.reduce((m, r) => {
    m.received += r.received;
    m.created += r.created;
    m.updated += r.updated;
    m.skipped += r.skipped;
    m.failed += r.failed;
    return m;
  }, { received: 0, created: 0, updated: 0, skipped: 0, failed: 0 });
  return { ok: true, mode, channels: results, totals };
}

module.exports = {
  KIND, VERSION, FIELDS, REQUIRED,
  exportPayload, summarize, importPayload, importChannel,
  requestRegion,
};
