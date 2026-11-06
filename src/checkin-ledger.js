// src/checkin-ledger.js - 统一签到账本（按通道 + 账号 + 日期）
//
// 为什么要单独记一份：三条通道的签到历史可得性完全不同——
//   - 搭子：上游 sign_in_days 只给**当月**已签日，跨月就查不到；
//     本地 activity.jsonl 有历史，但那是「操作流水」（还混着失败尝试），
//     且只有搭子通道往里写。
//   - TRAE：上游完全不提供签到历史，账号上只有一个 lastCheckin。
//   - Qoder：上游不提供领取时刻，本地 qoder-grants.jsonl 记的是**积分批次**
//     （一次签到可能领多个活动），不能直接当「哪天签过」。
//
// 所以「某天某账号签到了」要单独记一份。数据**只从功能上线时开始有**，
// 不编造历史——管理端接口会如实返回覆盖起点（since）。
//
// 与 activity.jsonl 的分工：那个记「这次点了什么、结果如何」（含失败），
// 这个只记「这天签成了」。查询时两者会合并，后者是主口径。
const fs = require('fs');
const path = require('path');

const FILE = 'checkin-ledger.jsonl';

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
}

function filePath() {
  return path.join(dataDir(), FILE);
}

/**
 * 本地日期 YYYY-MM-DD。
 *
 * **不能用 toISOString().slice(0,10)**：那是 UTC 日期，UTC+8 的凌晨 0-8 点
 * 会被算成前一天，签到日历会整体错位一格。服务端与用户都在东八区，
 * 这里按本机时区取日期。
 */
function dayOf(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readAll() {
  try {
    return fs.readFileSync(filePath(), 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

function keyOf(channel, accountId, day) {
  return `${channel}|${Number(accountId)}|${day}`;
}

/**
 * 记一次签到。**按 channel + account_id + day 幂等**——同一天重复点签到、
 * 或「已签」分支被反复触达，都只留一条。
 *
 * @returns {boolean} 是否新写入
 */
function append(entry) {
  return appendMany([entry]) > 0;
}

/**
 * 批量写入（用于「从上游回填当月」）：一次读盘、一次写盘，
 * 避免 31 天各读一遍整个文件。
 *
 * @returns {number} 实际新增条数
 */
function appendMany(entries) {
  try {
    const list = (entries || []).filter((e) => e && e.channel && e.account_id != null);
    if (!list.length) return 0;
    const seen = new Set(readAll().map((r) => keyOf(r.channel, r.account_id, r.day)));
    const fresh = [];
    for (const e of list) {
      const at = Number(e.at) || Date.now();
      const day = e.day || dayOf(at);
      const k = keyOf(e.channel, e.account_id, day);
      if (seen.has(k)) continue;
      seen.add(k);
      fresh.push({
        channel: e.channel,
        account_id: e.account_id,
        account: e.account || '',
        day,
        at,
        credits: e.credits == null ? null : e.credits,
        source: e.source || '',
      });
    }
    if (!fresh.length) return 0;
    fs.mkdirSync(dataDir(), { recursive: true });
    // M3 账本原子追加：批量多行拼成一个 buffer 单次写（原子性以单次 write
    // 为界，与行数无关）；幂等判据 readAll 在锁外有竞态，但读侧按 key 去重、
    // 双写零伤害——与 qoder/grants 同款取舍
    require('./jsonl').append(filePath(), fresh.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return fresh.length;
  } catch (e) {
    // 记账失败不影响签到本身，但历史会缺一条——返回 0 让调用方知道
    return 0;
  }
}

/** 某通道在 [fromDay, toDay] 内的记录（日期是 YYYY-MM-DD，可直接字符串比较） */
function rowsInRange({ channel, fromDay, toDay }) {
  return readAll().filter((r) => r
    && r.channel === channel
    && (!fromDay || r.day >= fromDay)
    && (!toDay || r.day <= toDay));
}

/** 某通道账本的最早一天（null = 还没有记录）。界面据此如实标注覆盖范围。 */
function coverage({ channel }) {
  const rows = readAll().filter((r) => r && r.channel === channel && r.day);
  if (!rows.length) return { since: null, count: 0 };
  const days = rows.map((r) => r.day).sort();
  return { since: days[0], count: rows.length };
}

module.exports = { FILE, dataDir, filePath, dayOf, append, appendMany, readAll, rowsInRange, coverage };
