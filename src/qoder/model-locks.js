// src/qoder/model-locks.js - 模型锁池视图（P2-19）
//
// 出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P2-19「模型条件查询 + 模型锁池视图」
// （workbuddy panel「模型与档位」视图）。
//
// **要回答的问题**：「Qoder 用不了」到底是整条通道挂了，还是**某个模型**在排队？
// 本项目早就把限流做成 (账号, 模型) 粒度的模型级冷却
// （`pool.applyModelSoftCooldown`，因为实测同一分钟一个账号的 dfmodel 排 4697 位、
// 另一个账号的 qfmodel 直接 200），但**这个状态从来没有可视化面**——用户只知道
// 「配了 dfmodel 用不了」，不知道「换 qfmodel 立刻可用」。这正是「Qoder 用不了、
// 网页版正常」那类事故的误诊根源。
//
// 口径：
//   · 数据源是**池快照**（`pool.snapshot()` 的 `model_cooldowns`），只含未到期的
//   · `available` = 可选账号数 = 已登记账号数 − 锁定账号数；账号总数由调用方给
//   · `earliestUntil` / `allClearUntil` 分开给：「最早有一个号解锁」与
//     「全池解锁」是完全不同的两个时刻，只给前者会让人以为马上就通了
//   · **无锁定是正常态**，如实返回空数组而不是造一行「全部正常」——前端据此显示
//     「所有模型均可选」这句话，而不是让界面自己编一句
//
// 纯函数、不读盘、不打上游：离线可测，且可以在任何进程里算。
'use strict';

/**
 * 把池快照聚合成「每个被锁模型一行」。
 *
 * @param {Array} snap `pool.snapshot()` 的返回（每账号一行）
 * @param {object} [opts]
 *   opts.prefix   uid 前缀（'qoder:'）。给定时只统计该通道的账号——
 *                 **必须给**：池是所有通道共用的，不过滤会混进别的通道的锁
 *   opts.total    该通道已登记账号总数（前端据此算「可选 x/y」）。
 *                 0/未给时 available 按「未锁的账号数」给，不编总数
 *   opts.now      当前时刻（可注入，便于测试）
 * @returns {{models:Array, totalAccounts:number, lockedAccounts:number, cleared:boolean}}
 */
function aggregateLocks(snap, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const prefix = String(opts.prefix || '');
  const reportedTotal = Number(opts.total);

  const rows = (snap || []).filter((r) => {
    if (!r || !r.id) return false;
    if (!prefix) return true;
    return String(r.id).startsWith(prefix);
  });

  // 同一账号可能对多个模型排队：按 (模型, 账号) 展开后再按模型聚合
  const byModel = new Map();
  const lockedUids = new Set();
  for (const r of rows) {
    for (const mc of (r.model_cooldowns || [])) {
      if (!mc || !mc.model) continue;
      // snapshot 已过滤过 until > now，这里再判一次：注入 now 与调用方时刻
      // 不一致时必须按 now 重新判，否则「刚过期」的锁还会显示出来
      if (!(mc.until > now)) continue;
      lockedUids.add(String(r.id));
      let cell = byModel.get(mc.model);
      if (!cell) {
        cell = {
          model: mc.model,
          accounts: [],
          accountCount: 0,
          earliestUntil: 0,
          allClearUntil: 0,
          maxHits: 0,
          reasons: [],
          kind: '',
        };
        byModel.set(mc.model, cell);
      }
      cell.accounts.push(String(r.id).replace(prefix, ''));
      cell.accountCount += 1;
      if (!cell.earliestUntil || mc.until < cell.earliestUntil) cell.earliestUntil = mc.until;
      if (!cell.allClearUntil || mc.until > cell.allClearUntil) cell.allClearUntil = mc.until;
      const hits = Number(mc.hits) || 0;
      if (hits > cell.maxHits) cell.maxHits = hits;
      const reason = clampReason(mc.reason);
      if (reason && !cell.reasons.some((x) => x.text === reason)) {
        cell.reasons.push({ text: reason, count: 1 });
      } else if (reason) {
        const hit = cell.reasons.find((x) => x.text === reason);
        hit.count += 1;
      }
    }
  }

  const models = [...byModel.values()]
    .map((cell) => ({
      model: cell.model,
      // 账号 id 去掉前缀，前端要显示「哪些号」
      accounts: cell.accounts.sort(),
      accountCount: cell.accountCount,
      // 最早/全解 两种时刻：只给前者会让人以为马上就通了
      earliestUntil: cell.earliestUntil,
      earliestInMs: Math.max(0, cell.earliestUntil - now),
      allClearUntil: cell.allClearUntil,
      allClearInMs: Math.max(0, cell.allClearUntil - now),
      maxHits: cell.maxHits,
      // 次数最多的那条原因（上游原文，已截断）
      reason: cell.reasons.sort((a, b) => b.count - a.count)[0]
        ? cell.reasons.sort((a, b) => b.count - a.count)[0].text : '',
      reasons: cell.reasons.sort((a, b) => b.count - a.count),
      kind: kindOf(cell.reasons),
    }))
    // 先按「全池解锁最快」排，再看锁了几个号——快通的排前面（那是用户该换的模型）
    .sort((a, b) => (a.allClearUntil - b.allClearUntil) || (a.accountCount - b.accountCount));

  const lockedAccounts = lockedUids.size;
  const totalAccounts = Number.isFinite(reportedTotal) && reportedTotal > 0 ? reportedTotal : rows.length;
  return {
    models,
    totalAccounts,
    lockedAccounts,
    // 可选账号数：已登记总数 − 被锁账号数。负数夹到 0（总数给错时不留负数）
    available: Math.max(0, totalAccounts - lockedAccounts),
    cleared: models.length === 0,
  };
}

/** 上游原文可能很长（信封嵌套），截断到能看懂的宽度 */
function clampReason(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > 160 ? `${t.slice(0, 160)}…` : t;
}

/**
 * 锁的类别：排队（等就好）还是配额/模型问题（换模型）。
 *
 * 判据与 `upstream-errors` 一致但**只看 reason 文本**——锁池视图拿不到原始
 * 错误对象，只有 clampMsg 之后的串。所以这里只做粗分：文本里带排队特征
 * （10605 / isQueued / RESOURCE_LIMIT / CALL_COUNT_LIMIT）就算排队，其余
 * 归「其它」。**不做自动处置建议**：判错的代价是让人白等或白换模型，
 * 两个都不轻，所以只标注类别让人自己判。
 */
function kindOf(reasons) {
  const blob = (reasons || []).map((r) => r.text).join(' ');
  if (/10605|isQueued|RESOURCE_LIMIT|CALL_COUNT_LIMIT|排队/i.test(blob)) return 'queue';
  if (/quota|额度|pricingUrl|Billing daily/i.test(blob)) return 'quota';
  if (/model/i.test(blob)) return 'model';
  return 'other';
}

module.exports = { aggregateLocks, kindOf, clampReason };
