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
    // 归属核验（P0-2）：'claimed' / 'same_person' / 'unverified'。
    // 老行没有这两个字段——读侧按 'unverified' 处理（缺失 ≠ 已核验通过）
    verification: r.verification || 'unverified',
    verified: r.verified === true ? true : (r.verified === false ? false : null),
    samePerson: r.samePerson === true,
    verifyNote: r.verifyNote || '',
    ts: now,
  };
}

/**
 * 账本行补「这条到底有没有真的进账」的核验字段（P0-2）。
 *
 * **为什么金额字段旁边还需要它**：`amount` 是「领取额」，而多账号场景下
 * 服务端可能判定「同一个人」→ 后领的号**没有任何积分进账**（只有先领的那个
 * 拿到）。账本若只有 amount，FEFO 推算剩余会把这个号也算成有积分，选号跟着错。
 *
 * 三态判据（纯函数，离线可测；出处 workbuddy2api 面板 2026-11-04 实测）：
 *   'claimed'   CLAIMED + grantId 与本号领取响应一致 → 真领到
 *   'same_person'  BLOCKED + SAME_PERSON → 额度被同一个人的另一账号领走
 *   'unverified'   问不出结论 → **如实标未核实，不猜不假报**
 *
 * @param {object} verify session.verifyClaim 的返回
 * @param {string} ourGrantId 本号领取响应里的 grantId
 * @returns {{verification:'claimed'|'same_person'|'unverified', verified:boolean|null, samePerson:boolean, verifyNote:string}}
 */
function classifyVerification(verify, ourGrantId) {
  if (!verify || verify.ok !== true) {
    // 端点不可用（404/405）与「请求失败」要分开说：前者说明这个上游版本没有
    // 核验接口（永远未核实），后者是瞬时故障（下次可能核得出来）。
    const note = verify && verify.unsupported
      ? '核验端点不可用（该上游版本没有 reward 接口）'
      : `核验请求失败${verify && verify.error ? `：${verify.error}` : ''}`;
    return { verification: 'unverified', verified: null, samePerson: false, verifyNote: note };
  }
  if (verify.samePerson) {
    return {
      verification: 'same_person',
      verified: false,
      samePerson: true,
      verifyNote: '上游判定为同一人已领取（额度进了另一个号）——本号没有积分进账，账本不按领取额计',
    };
  }
  const status = String(verify.status || '').toUpperCase();
  if (status === 'CLAIMED') {
    // grantId 一致才是「这条确实记在本号上」。不一致/缺失时报未核实
    // ——「已领取」与「领到了这个 grantId」是两个粒度。
    if (verify.grantId && ourGrantId && verify.grantId === ourGrantId) {
      return { verification: 'claimed', verified: true, samePerson: false, verifyNote: '' };
    }
    if (verify.grantId && ourGrantId && verify.grantId !== ourGrantId) {
      return {
        verification: 'unverified', verified: null, samePerson: false,
        verifyNote: `核验返回的 grantId（${verify.grantId}）与本号领取响应（${ourGrantId}）不一致`,
      };
    }
    // 上游没给 grantId：状态对但无法逐条比对，如实未核实
    return {
      verification: 'unverified', verified: null, samePerson: false,
      verifyNote: '上游核验未返回 grantId，无法与本号领取响应比对',
    };
  }
  if (status === 'BLOCKED') {
    return {
      verification: 'unverified', verified: false, samePerson: false,
      verifyNote: `核验状态 BLOCKED 但未给出同人标记（status=${verify.status}）`,
    };
  }
  return {
    verification: 'unverified', verified: null, samePerson: false,
    verifyNote: verify.status ? `核验状态未知（status=${verify.status}）` : '核验未返回状态',
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

/**
 * 积分到期分布（P2-18）。
 *
 * 出处：workbuddy panel「积分构成」视图的**到期分布**——按批次到期日聚合、
 * 颜色区分账号、危险度色点、**到期前日均需耗量**（拿「推算剩余 ÷ 剩余天数」
 * 直接算）。
 *
 * 为什么要聚合而不只列明细：本项目已有逐批明细（`/grants`），但「哪些天会
 * 同时作废多少」看不出来——30 天有效期 + 每天领 100 的话，每天都有一笔在
 * 到期，明细里是一堆相同的行；聚合后才发现「明天一口气作废 300」这种真风险。
 *
 * **口径**：amount 仍是**领取额**，`remaining` 才是推算剩余（来自
 * estimateRemaining 的先领先扣分配）。日均需耗量用**推算剩余**算，
 * 用领取额算会高估（用户可能早就花掉了）。
 *
 * @param {Array} batches 批次列表（调用方只传未过期的）
 * @param {number} now 当前时刻（可注入）
 * @returns {Array<{date, grantCount, amounts, remaining, accounts, daysLeft, dailyNeed, warn}>}
 */
function expiryDistribution(batches, now = Date.now()) {
  const byDay = new Map();
  for (const b of (batches || [])) {
    if (!b || !b.expiresAt || b.expiresAt <= now) continue;
    const d = new Date(b.expiresAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let cell = byDay.get(key);
    if (!cell) {
      // daysLeft 按**自然日差**算，不是 ceil(ms/86400000)：跨日边界上
      // 后者会把「明天到期」算成 1 天而「今天 23:59 到期」也算 1 天，
      // 日均需耗量于是不可比。按日期差才是「还有几天可以花」。
      const today = new Date(now);
      const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      const t1 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      cell = {
        date: key,
        grantCount: 0,
        // 领取额合计（对照口径，不随消耗变）
        amounts: 0,
        // 推算剩余合计（真正的「会作废多少」）
        remaining: 0,
        accounts: new Set(),
        daysLeft: Math.max(0, Math.round((t1 - t0) / 86400000)),
        dailyNeed: 0,
        warn: '',
      };
      byDay.set(key, cell);
    }
    cell.grantCount += 1;
    if (typeof b.amount === 'number') cell.amounts += b.amount;
    // estimatedRemaining 由调用方算好挂在批次上（Map 取不到时给 0——
    // 分不出去的批次确实不持有余额）。**null 不参与合计**：null 是
    // 「推不出来」，把它当 0 会让合计看起来比实际少。
    if (typeof b.estimatedRemaining === 'number') cell.remaining += b.estimatedRemaining;
    if (b.accountId != null) cell.accounts.add(b.accountId);
  }
  const out = [...byDay.values()].map((cell) => {
    const days = Math.max(1, cell.daysLeft); // 今天到期按 1 天算，避免除零
    const remaining = Math.round(cell.remaining * 10000) / 10000;
    const dailyNeed = Math.round((remaining / days) * 100) / 100;
    let warn = '';
    if (cell.daysLeft <= 1 && remaining > 0) warn = 'critical';
    else if (cell.daysLeft <= 3 && remaining > 0) warn = 'high';
    else if (cell.daysLeft <= 7 && remaining > 0) warn = 'watch';
    return {
      date: cell.date,
      grantCount: cell.grantCount,
      amounts: Math.round(cell.amounts * 10000) / 10000,
      remaining,
      accounts: [...cell.accounts],
      accountCount: cell.accounts.size,
      daysLeft: cell.daysLeft,
      dailyNeed,
      warn,
    };
  });
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

module.exports = {
  FILE, filePath, record, readAll, hasGrant, fromClaim, expiring, expired, estimateRemaining,
  classifyVerification, expiryDistribution,
};
