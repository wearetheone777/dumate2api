// src/records.js - 统一的操作记录（签到 / 任务 / 抽奖 / 积分）
//
// 为什么单独建一层：这些动作分散在三个地方——签到状态只存在账号对象里
// （上游返回的 sign_in_days 是「哪天签过」，不是「我什么时候去签的」），
// 任务记录在 task-runs.jsonl，抽奖结果只在抽奖那一刻的响应里。
// 汇总成一个按时间排序的记录流，才能回答「这个账号这几天都发生了什么」。
const fs = require('fs');
const path = require('path');
const jsonl = require('./jsonl');

const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
const FILE = 'activity.jsonl';

function append(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // M3 账本原子追加：走 jsonl.append（锁内轮转 + 单次 Buffer write），
    // 跨进程并发不再有丢行/交错窗口
    jsonl.append(path.join(DATA_DIR, FILE), `${JSON.stringify({ ts: Date.now(), ...entry })}\n`);
  } catch (e) { /* 记录失败不能影响动作本身 */ }
}

// 记录对外展示的时间。自动发放是补记的：写入时刻 ts 是「我们查到的时刻」，
// 而它对外的发生时间是 granted_at（服务端当天 00:00 发的）。排序必须用展示时间，
// 否则会出现「显示 00:00 的那行排在最前面」——看着像顺序错乱。
function effectiveTs(r) {
  return r.type === 'grant' && r.granted_at ? r.granted_at : r.ts;
}

// 读记录。返回 { rows, total }，rows 按时间倒序（最新在前）。
// 注意：文件不存在时也要返回同样的形状——早先直接 return []，
// 调用方按 { rows } 解构就会炸（实测 "rows is not iterable"）。
function read(opts = {}) {
  const { limit = 200, account_id = null, type = null, since = null } = opts;
  let rows = [];
  try {
    rows = fs.readFileSync(path.join(DATA_DIR, FILE), 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) {
    return { rows: [], total: 0 };
  }

  if (account_id) rows = rows.filter((r) => Number(r.account_id) === Number(account_id));
  if (type) rows = rows.filter((r) => r.type === type);
  if (since) rows = rows.filter((r) => effectiveTs(r) >= since);

  const total = rows.length;
  // 按展示时间倒序，不再依赖文件写入顺序
  rows = rows.sort((a, b) => effectiveTs(b) - effectiveTs(a));
  return { rows: limit > 0 ? rows.slice(0, limit) : rows, total };
}

// 按账号 + 日期聚合，供日历视图
function dailySummary(days = 30) {
  const since = Date.now() - days * 86400000;
  const { rows } = read({ limit: 0, since });
  const byAccount = {};

  for (const r of rows) {
    const key = r.account_id;
    if (!byAccount[key]) {
      byAccount[key] = { account_id: key, account: r.account || '', days: {}, counts: {} };
    }
    const a = byAccount[key];
    // 与 read() 同口径：归到「对外展示的那天」，避免补记的发放
    // 在跨零点的情况下被算进查询那天
    const day = new Date(effectiveTs(r)).toISOString().slice(0, 10);
    if (!a.days[day]) a.days[day] = {};
    // 同一天同类动作可能多次（如多次抽奖），按类型累加次数
    a.days[day][r.type] = (a.days[day][r.type] || 0) + 1;
    a.counts[r.type] = (a.counts[r.type] || 0) + 1;
  }
  return Object.values(byAccount);
}

// 积分快照：动作前后各取一次，差值就是这次动作带来的积分变化。
//
// 为什么用差值而不是接口返回的字段：签到接口只返回 true，任务接口也不带
// 奖励金额；上游唯一权威的积分口径是 quota_overview 的余额。差值法是实测
// 出来的真值，而且签到/任务/抽奖三条路径能共用同一套逻辑。
//
// 用 left（可用余额）而不是 total（累计总量）作为对比基准：
// 「余额 26 → 56」是用户实际能用的钱；总量会受模型消耗影响，
// 看起来会像「发了 30 但总量只涨了 10」，容易误读。
async function pointsSnapshot(cookie, account) {
  try {
    const web = require('./dumate-web');
    // 出站代理（E 包收口补点）：与对话同出口；配置非法走 catch 返 null
    //（快照缺失只是差值算不出，不能变成一次直连）
    const agent = account ? web.agentFor(account) : null;
    const r = await web.api.quotaOverview(cookie, { agent });
    if (!r.ok) return null;
    return { left: r.left, total: r.total, at: Date.now() };
  } catch (e) {
    return null;
  }
}

// 算积分变化。返回 { delta, before, after } —— 三个值都要留着：
// 差值说明「这次发了多少」，前后值说明「从多少变到多少」，
// 后者能让人一眼看出是首次发放（0 → 30）还是累加（26 → 56）。
//
// 快照缺失（接口失败）时返回 delta: null 而不是 0——0 会被读成
// 「这次没给积分」，而真相是「没测到」，两者含义不同。
function pointsDelta(before, after) {
  const b = before ? before.left : null;
  const a = after ? after.left : null;
  if (b === null || a === null) return { delta: null, before: b, after: a };
  const d = a - b;
  return {
    delta: Number.isFinite(d) ? Math.round(d * 100) / 100 : null,
    before: Math.round(b * 100) / 100,
    after: Math.round(a * 100) / 100,
  };
}

module.exports = { append, read, dailySummary, pointsSnapshot, pointsDelta, FILE };
