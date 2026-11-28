// src/admin/trash.js - 账号回收站（批次十六，参考 qoder-trae-workbuddy-switch trash.rs）
//
// 为什么删除必须是「软」的：账号库里内嵌凭据（token/cookie），硬删除一旦点错就是
// 不可逆的数据丢失——令牌不在别处，只能重新走一遍登录。软删除把误删的代价从
// 「重新登录」降到「点一次恢复」；「真正销毁」（purge）收窄成唯一一个显式动作，
// 前端必须过 danger 二次确认（服务端也要求 confirm:true，双确认）。
//
// ## 存储形态：独立回收站文件，不动 live 账号文件
//
// 五条通道各一个 `<live 文件名>-trash.json`（含凭据，writeJSON 已做 0600 + 权限收紧）。
// 刻意**不**用「live 文件里加 trashedAt 标记」的方案：pool 选号 / keepalive / FEFO /
// 积分视图都直接读 live accounts 列表，标记方案要求每个消费方都记得过滤，
// 漏一处就是「已删除的账号继续接流量」的静默故障。搬走记录让 live 文件根本不含
// 回收站成员——消费方零改动。
//
// ## 写入顺序：新增侧先落，删除侧后落
//
// 软删除（live → trash）与恢复（trash → live）都是跨两个文件的搬移，两次写不可能
// 原子。统一先写「接收方」、后写「来源方」：中途失败的最坏情形是「两边都有」
// （可恢复的冗余），绝不是「两边都没有」（数据丢失）。
//
// ## fail-closed
//
// - 认不出的 key ⇒ 恢复 / 永久删除拒绝，不静默当成功；
// - live 已存在同 id ⇒ 恢复拒绝（不覆盖——恢复不能成为冲掉现有账号的隐蔽入口）；
// - 回收站文件解析失败 ⇒ 所有写路径拒绝（宁可不写，不在损坏库上覆盖；
//   参考实现同款纪律：把损坏当空库写空等于在误判上把仅存数据抹掉）。
//
// ## 与参考实现的刻意偏离
//
// - 时间用**毫秒数**（deletedAt/expiresAt），不用 ISO 字符串——本仓库的落盘
//   时间戳（reqlogs/activity/points-cursor）全是毫秒，解析零成本；
// - 保留期清扫跑在**管理端进程**（boot + 每小时 + 列表时顺带），不在网关
//   keepalive 里——删除/恢复/清空全部只发生在管理端，网关进程从不写回收站文件，
//   单进程写就单进程清，不引入跨进程写竞争；
// - key = 各通道账号存储的数字 id（本仓库账号记录的唯一键），不是 uid。

const fs = require('fs');
const store = require('./store');
const filelock = require('../filelock');

// 保留期（天）与条数上限。上限防「批量导入 → 批量删除」把含凭据的文件撑到无限大；
// 先到先出（按删除时间，最旧的先清）。
const TRASH_RETENTION_DAYS = 30;
const TRASH_MAX_ENTRIES = 200;
const SWEEP_INTERVAL_MS = 3600000; // 1 小时

// 每通道一份规格。mod 惰性 require（与 backup.js 的 storeOf 同款）——
// 本模块只被管理端加载，但被 require 时不想连带拉起全部通道模块。
const SPECS = {
  dumate: {
    file: 'web-accounts-trash.json',
    mod: () => require('../accounts'),
    // 显示名走 accounts.displayName（占位名识别 + name/nickname 优先级都在那一处）
    nameOf: (a) => require('../accounts').displayName(a) || `账号 ${a.id}`,
  },
  qwenwork: {
    file: 'qwenwork-accounts-trash.json',
    mod: () => require('../qwenwork/auth'),
    nameOf: (a) => a.nickname || a.phone || `账号 ${a.id}`,
  },
  traework: {
    file: 'traework-accounts-trash.json',
    mod: () => require('../traework/auth'),
    nameOf: (a) => a.nickname || `账号 ${a.id}`,
  },
  qoder: {
    file: 'qoder-accounts-trash.json',
    mod: () => require('../qoder/auth'),
    nameOf: (a) => a.nickname || a.username || a.email || a.phone || `账号 ${a.id}`,
  },
  workbuddy: {
    file: 'workbuddy-accounts-trash.json',
    mod: () => require('../workbuddy/auth'),
    nameOf: (a) => a.nickname || `账号 ${a.id}`,
  },
};

function specOf(channel) {
  const spec = SPECS[channel];
  if (!spec) throw new Error(`未知通道「${channel}」：回收站只认 ${Object.keys(SPECS).join('/')}`);
  return spec;
}

// 宽松读：文件缺失 ⇒ []；解析失败 ⇒ null（写路径据此拒绝，列表路径据此标 corrupt）。
// 列表要「界面能起来」，写路径必须知道底数——与参考实现的 load/load_checked 分工同款。
function readEntries(spec) {
  let raw;
  try {
    raw = fs.readFileSync(store.dataPath(spec.file), 'utf8');
  } catch (e) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return null;
  }
}

// 原子写走 store.writeJSON（0600 + fileperm 收紧 + rename），与凭证文件同款纪律。
function writeEntries(spec, entries) {
  store.writeJSON(spec.file, entries);
}

// 排序键：删除时刻；**解析不出记最旧**（最先被裁）——回落成「现在」会把坏记录
// 伪装成刚写入的。毫秒数使这里的判定零解析成本（参考实现为此写了 parse_iso）。
function sortKeyOf(entry) {
  return Number.isFinite(entry && entry.deletedAt) ? entry.deletedAt : Number.NEGATIVE_INFINITY;
}

// 留存策略（**纯函数**，可单测）：清过期 + 裁上限（先到先出）。
// - **过期**：expiresAt 解析不出（字段缺失/被手改坏）⇒ 一律视为已过期。回收站是
//   凭据的临时存放点不是长期仓库，把读不懂的记录当「永不过期」会让凭据永久留盘。
// - **上限**：按删除时间倒序保留最新的 TRASH_MAX_ENTRIES 条（最旧的先出）。
function sweepEntries(entries, now) {
  const before = entries.length;
  let kept = entries.filter((e) => Number.isFinite(e && e.expiresAt) && e.expiresAt > now);
  if (kept.length > TRASH_MAX_ENTRIES) {
    kept = kept.slice().sort((a, b) => sortKeyOf(b) - sortKeyOf(a)).slice(0, TRASH_MAX_ENTRIES);
  }
  return { entries: kept, removed: before - kept.length };
}

// 留存清扫（单通道）：只在确实清掉了东西时才落盘——空跑不产生 IO，
// 也不会把「读损坏了」误写成「清空了」。返回被清理条数（损坏 ⇒ 0）。
function sweepTrash(channel) {
  const spec = specOf(channel);
  const entries = readEntries(spec);
  if (entries === null) return 0;
  const { entries: kept, removed } = sweepEntries(entries, Date.now());
  if (removed > 0) writeEntries(spec, kept);
  return removed;
}

// 软删除：把账号从 live **移入**回收站（凭据随记录原样搬走 ⇒ 恢复无损）。
//
// 顺序是**先写 trash、后删 live**（见模块头）：trash 写成功而 remove 失败时
// 回滚 trash 条目并如实报错；反过来的顺序一旦第二步 IO 失败，账号就从两个文件里
// 同时消失。remove 返回 false（并发删除抢了先）也走同一条回滚。
//
// 快照与 remove 之间不持锁：本进程（管理端）的处理器是同步串行的，跨进程的
// 并发 patch 最坏只让回收站里的快照略旧（凭证恢复后照常刷新），live 删除本身
// 由各通道 auth 模块在自己的 filelock 里完成。
function trashAccount(channel, id) {
  const spec = specOf(channel);
  const mod = spec.mod();
  const trash = readEntries(spec);
  if (trash === null) {
    return { ok: false, error: `回收站文件损坏，拒绝写入（先手工处理 ${spec.file}）` };
  }
  const key = String(id);
  const data = mod.load();
  const acc = (data.accounts || []).find((a) => String(a.id) === key);
  if (!acc) return { ok: false, error: '账号不存在' };

  const now = Date.now();
  const entry = {
    key,
    id: acc.id,
    name: spec.nameOf(acc),
    deletedAt: now,
    expiresAt: now + TRASH_RETENTION_DAYS * 86400000,
    account: acc,
  };
  // 幂等：先清掉同 key 的旧条目，避免「上次 trash 写成功、live 写失败」的重试留下双份。
  const next = trash.filter((e) => e.key !== key);
  next.push(entry);
  const { entries: swept } = sweepEntries(next, now);
  writeEntries(spec, swept);

  const ok = mod.remove(id);
  if (!ok) {
    // 回滚：live 侧没删成（并发删除 / id 已消失），把刚写入的条目撤回来。
    writeEntries(spec, swept.filter((e) => e.key !== key));
    return { ok: false, error: '账号不存在' };
  }
  return { ok: true, name: entry.name };
}

// 恢复：把账号从回收站**移回** live（谓词 = entry.key === key）。
//
// - 认不出的 key ⇒ 拒绝（界面上的条目是具体的，找不到就是状态陈旧，必须让调用方
//   看见，而不是假装恢复了一条不存在的账号）；
// - live 已存在同 id ⇒ 拒绝（不覆盖；恢复走的写入在同一把 live 文件锁里做，
//   与各通道 auth 模块的写路径互斥）；
// - preferred 排他归一：恢复一条「主账号」时若 live 已有别的 preferred，
//   剥掉恢复副本的标记（qwenwork/patch 的排他语义、qoder remove 的顺延逻辑
//   都默认池里至多一个 preferred，两个 preferred 会让选号静默退化成取第一个）。
function restoreAccount(channel, key) {
  const spec = specOf(channel);
  const mod = spec.mod();
  const trash = readEntries(spec);
  if (trash === null) {
    return { ok: false, error: `回收站文件损坏，拒绝写入（先手工处理 ${spec.file}）` };
  }
  const idx = trash.findIndex((e) => e.key === String(key));
  if (idx < 0) return { ok: false, error: '回收站中没有该账号' };
  const entry = trash[idx];

  const target = mod.filePath();
  let pushed = null;
  const writeErr = filelock.withLock(target, () => {
    const data = mod.load();
    if ((data.accounts || []).some((a) => String(a.id) === String(entry.id))) {
      return '账号库中已存在该账号，无法恢复';
    }
    let record = entry.account;
    if (record && record.preferred && (data.accounts || []).some((a) => a.preferred)) {
      record = { ...record, preferred: false };
    }
    data.accounts = [...(data.accounts || []), record];
    mod.save(data);
    pushed = record;
    return '';
  });
  if (writeErr) return { ok: false, error: writeErr };

  // live 先落（失败时条目原样保留在内存态、未动 trash），trash 后落。
  writeEntries(spec, trash.filter((e) => e.key !== String(key)));
  return { ok: true, name: entry.name, account: pushed };
}

// 永久删除（**唯一不可逆步**）：从回收站真删。凭据内嵌在记录里，随记录一并销毁。
// 认不出的 key ⇒ 拒绝；retain 会清掉所有同 key 条目（盘上即便因历史缺陷有重复
// 也一次清干净）。
function purgeAccount(channel, key) {
  const spec = specOf(channel);
  const trash = readEntries(spec);
  if (trash === null) {
    return { ok: false, error: `回收站文件损坏，拒绝写入（先手工处理 ${spec.file}）` };
  }
  const before = trash.length;
  const next = trash.filter((e) => e.key !== String(key));
  if (next.length === before) return { ok: false, error: '回收站中没有该账号' };
  writeEntries(spec, next);
  return { ok: true };
}

// 清空回收站，返回被删条数（**不可逆**）。文件损坏（解析失败）时**不覆盖**：
// 返回 removed:0 + corrupt 标记如实表示「没数出条目」——把损坏当空库直接写空，
// 等于把用户仅存的、也许还能手工抢救的数据彻底抹掉。
function clearTrash(channel) {
  const spec = specOf(channel);
  const entries = readEntries(spec);
  if (entries === null) return { ok: false, corrupt: true, removed: 0, error: '回收站文件损坏，拒绝覆盖' };
  if (entries.length > 0) writeEntries(spec, []);
  return { ok: true, removed: entries.length };
}

// 回收站列表（按删除时间**倒序**，最新在前）。清扫顺带跑——过期条目到点即消失，
// 不等下一轮整点。损坏 ⇒ entries 空 + corrupt:true（界面能起来，损坏如实可见）。
function listTrash(channel) {
  const spec = specOf(channel);
  sweepTrash(channel);
  let entries = readEntries(spec);
  let corrupt = false;
  if (entries === null) {
    entries = [];
    corrupt = true;
  }
  const now = Date.now();
  const rows = entries
    .slice()
    .sort((a, b) => sortKeyOf(b) - sortKeyOf(a))
    .map((e) => ({
      key: e.key,
      id: e.id,
      name: e.name || `账号 ${e.id}`,
      deletedAt: Number.isFinite(e.deletedAt) ? e.deletedAt : null,
      expiresAt: Number.isFinite(e.expiresAt) ? e.expiresAt : null,
      expiresInDays: Number.isFinite(e.expiresAt)
        ? Math.max(0, Math.ceil((e.expiresAt - now) / 86400000))
        : null,
    }));
  return { ok: true, corrupt, retentionDays: TRASH_RETENTION_DAYS, maxEntries: TRASH_MAX_ENTRIES, entries: rows };
}

// 四条回收站路由的共享工厂：各通道 route 文件展开一行接入
// （`...require('../trash').routesFor('qoder')`）。
function routesFor(channel) {
  specOf(channel); // 接线期就校验 channel 拼写，别等第一次请求才炸
  const audit = (user, action, target, detail) => {
    try { require('./auth').audit((user && user.username) || 'admin', action, target, detail); } catch (e) { /* 审计失败不影响结果 */ }
  };
  return [
    {
      method: 'GET',
      path: '/trash',
      handler: ({ res }) => send(res, 200, listTrash(channel)),
    },
    {
      // 清空（不可逆）：服务端也要 confirm，与前端 danger 二次确认对齐
      method: 'POST',
      path: '/trash/clear',
      handler: ({ res, body, user }) => {
        if (!(body && body.confirm)) return send(res, 400, { ok: false, error: '清空回收站需要 confirm:true（不可逆操作）' });
        const r = clearTrash(channel);
        if (r.ok) audit(user, `${channel}_trash_clear`, '', String(r.removed));
        return send(res, r.ok ? 200 : 500, r);
      },
    },
    {
      method: 'POST',
      path: '/trash/:key/restore',
      handler: ({ res, params, user }) => {
        const r = restoreAccount(channel, params[0]);
        if (r.ok) audit(user, `${channel}_account_restore`, params[0], r.name || '');
        return send(res, r.ok ? 200 : 400, r);
      },
    },
    {
      // 永久删除（不可逆）：同上要求 confirm:true
      method: 'DELETE',
      path: '/trash/:key',
      handler: ({ res, params, body, user }) => {
        if (!(body && body.confirm)) return send(res, 400, { ok: false, error: '永久删除需要 confirm:true（不可逆操作）' });
        const r = purgeAccount(channel, params[0]);
        if (r.ok) audit(user, `${channel}_trash_purge`, params[0]);
        return send(res, r.ok ? 200 : 400, r);
      },
    },
  ];
}

function send(res, code, obj) {
  require('./router').sendJSON(res, code, obj);
}

// 留存清扫循环（管理端进程）：boot 先跑一轮 + 每小时一次。
// 显式由 admin/server.js 调用——require 即启动会让测试里的 require 产生定时器。
function startSweep() {
  const channels = Object.keys(SPECS);
  const run = () => channels.forEach((c) => { try { sweepTrash(c); } catch (e) { /* 单通道失败不影响其余 */ } });
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = {
  TRASH_RETENTION_DAYS,
  TRASH_MAX_ENTRIES,
  SPECS,
  sweepEntries,
  sweepTrash,
  trashAccount,
  restoreAccount,
  purgeAccount,
  clearTrash,
  listTrash,
  routesFor,
  startSweep,
};
