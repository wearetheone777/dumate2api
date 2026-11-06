// src/qoder/grants.js - Qoder 积分批次账本（本地记录，用于过期提醒）
//
// **为什么需要本地记**：Qoder 没有「逐批积分余额」接口（实测 /api/v2/quota/detail
// 等一律 503，/sash/.../grants 一律 404）。唯一带到期信息的是**领取响应本身**
// （`benefit.validity` = RELATIVE_DAYS / 30 天 + `grantedAt`）。所以每次签到
// 落一条本地记录，过期信息才不会永久丢失。
//
// **金额的诚实边界**：上游只告诉我们「领了多少」，不告诉我们「这批还剩多少」。
// 所以这里的 `amount` 是**领取额**，不是剩余额。界面上必须说清这点——
// 把它当剩余额会高估（用户可能已经花掉了）。这与千问/TRAE 的
// 「每包有独立剩余」不同，是这条通道的数据缺口，如实标注而不是编一个数。
//
// 与 data/qwenwork-credits.jsonl（逐请求归因）的分工：那个记**花**，这个记**领**。
// 两者不要混——一个是消耗流，一个是获取流。
const fs = require('fs');
const path = require('path');

const FILE = 'qoder-grants.jsonl';

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
}

function filePath() {
  return path.join(dataDir(), FILE);
}

/**
 * 记一次领取。**幂等**：同一个 grantId 不重复写。
 * @returns {boolean} 是否新写入（false = 已存在，跳过）
 */
function record(entry) {
  try {
    if (!entry || !entry.grantId) return false;
    if (hasGrant(entry.grantId)) return false;
    fs.mkdirSync(dataDir(), { recursive: true });
    // M3 账本原子追加：幂等判据 hasGrant 在锁外有竞态（两进程同时 record
    // 同一 grantId 会双写）——但读侧消费按 grantId 去重，双写的伤害是零；
    // 丢行才是真伤害（过期提醒少一条），所以这里只解决原子性不加重锁
    require('../jsonl').append(filePath(), `${JSON.stringify(entry)}\n`);
    return true;
  } catch (e) {
    // 记账失败不该影响签到本身——但过期提醒会少一条，所以返回 false 让调用方知道
    return false;
  }
}

function readAll() {
  try {
    const lines = fs.readFileSync(filePath(), 'utf8').split('\n').filter(Boolean);
    const rows = [];
    for (const l of lines) {
      try { rows.push(JSON.parse(l)); } catch (e) { /* 跳过坏行 */ }
    }
    return rows;
  } catch (e) {
    return [];
  }
}

function hasGrant(grantId) {
  return readAll().some((r) => r && r.grantId === grantId);
}

/**
 * 由领取响应算出一条账本记录。
 *
 * @param {object} r claimCampaign 的返回（带 grantedAt / validityMode / validityDays）
 * @param {object} account 账号（取 id / nickname 用于展示与筛选）
 * @param {number} now 当前时刻（可注入，便于测试）
 * @returns {object|null} 无法确定到期时间时返回 null——不编一个假的
 */
function fromClaim(r, account, now = Date.now()) {
  if (!r || !r.ok) return null;
  // 到期时刻 = 领取时刻 + 有效期天数。两者缺一就推不出来。
  const grantedAt = r.grantedAt ? Date.parse(r.grantedAt) : now;
  if (!Number.isFinite(grantedAt)) return null;
  let expiresAt = null;
  if (r.validityMode === 'RELATIVE_DAYS' && typeof r.validityDays === 'number') {
    expiresAt = grantedAt + r.validityDays * 86400000;
  } else if (r.validityMode === 'ABSOLUTE' && r.validityEnd) {
    const t = Date.parse(r.validityEnd);
    if (Number.isFinite(t)) expiresAt = t;
  }
  return {
    // grantId 是幂等键。领取响应里有（实测字段名 grantId）
    grantId: r.grantId || '',
    accountId: account && account.id != null ? account.id : null,
    accountName: (account && (account.nickname || account.uid)) || '',
    campaignKey: r.campaignKey || '',
    amount: typeof r.amount === 'number' ? r.amount : null,
    grantedAt,
    expiresAt,
    validityMode: r.validityMode || '',
    validityDays: r.validityDays,
    modelScope: r.modelScope || null,
    ts: now,
  };
}

/**
 * 未过期的批次，按到期时间升序。**这是「过期提醒」的数据源**。
 *
 * @param {object} opts
 * @param {number} [opts.withinMs] 只看这个时间窗内到期的
 * @param {number} [opts.accountId] 只看某个账号
 * @param {number} [opts.now] 当前时刻（可注入）
 */
function expiring({ withinMs = 0, accountId = null, now = Date.now() } = {}) {
  const out = [];
  for (const r of readAll()) {
    if (!r || !r.expiresAt) continue;
    if (accountId != null && r.accountId !== accountId) continue;
    if (r.expiresAt <= now) continue; // 已过期的不算「即将过期」
    if (withinMs > 0 && r.expiresAt - now > withinMs) continue;
    out.push(r);
  }
  out.sort((a, b) => a.expiresAt - b.expiresAt);
  return out;
}

/** 已过期的批次（供排查「为什么积分少了」） */
function expired({ accountId = null, now = Date.now() } = {}) {
  return readAll().filter((r) => {
    if (!r || !r.expiresAt) return false;
    if (accountId != null && r.accountId !== accountId) return false;
    return r.expiresAt <= now;
  }).sort((a, b) => b.expiresAt - a.expiresAt);
}

/**
 * 按「先领先扣」把账号总余额分配回各批次，得每批的**推算剩余**。
 *
 * 为什么是推算而不是上游数据：上游扣费不按批次扣（扣的是 addOnQuota 总池），
 * 批次只是发放记录 + 有效期标签。但「领取后 30 天作废」的产品设计必然配
 * 「先到先用」——老批次先扣，余额留在最新批次上（这也是积分系统的标准
 * 行为，与网关自己的 FEFO 选号同序）。
 *
 * 分配规则：从最新批次往回分 remaining，每批最多拿满领取额，分完为止，
 * 更老的批次推算剩余 0。amount=null 的批次按 0 参与（领取额未知，
 * 不凭空给它余额）。调用方负责只传**未过期**批次——已过期批次已作废，
 * 不再持有余额，混进来会抢走本属于未过期批次的份额。
 *
 * 账本外批次（功能启用前领的）没有 grantId、不参与分配——remaining 分给
 * 账本批次后剩下的量就是它们的（端点层用它对账）。
 *
 * @param {Array} batches 批次列表（任意顺序，须带 grantId）
 * @param {number} remaining 账号 addOnQuota.remaining（上游权威总余额）
 * @returns {Map<string, number>} grantId → 推算剩余
 */
function estimateRemaining(batches, remaining) {
  const out = new Map();
  if (!Array.isArray(batches)) return out;
  const sorted = batches.filter((b) => b && b.grantId)
    .sort((a, b) => (b.grantedAt || 0) - (a.grantedAt || 0)); // 新 → 老
  let r = Number(remaining);
  if (!Number.isFinite(r) || r <= 0) {
    for (const b of sorted) out.set(b.grantId, 0);
    return out;
  }
  for (const b of sorted) {
    const cap = typeof b.amount === 'number' && b.amount > 0 ? b.amount : 0;
    const take = Math.min(cap, r);
    out.set(b.grantId, take);
    r -= take;
  }
  return out;
}

module.exports = { FILE, filePath, record, readAll, hasGrant, fromClaim, expiring, expired, estimateRemaining };
