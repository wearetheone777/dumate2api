// src/admin/routes/checkin.js - 签到详情（按月 / 按年）
//
// 回答「某年某月，哪些账号在哪几天签到了」。各通道各有各的账，这里合并成
// 同一个形状：
//   - 本地签到账本（src/checkin-ledger.js）：主口径，只记「签成了」
//   - 搭子 activity.jsonl：历史比账本长，补它
//   - 搭子上游 sign_in_days：**当月**的权威数据（跨月就查不到）
//   - Qoder qoder-grants.jsonl：签到领取的积分批次（含领取时刻）
//   - 各账号的 lastCheckin：兜底，只补最后一天
//
// **千问办公没有签到体系**（积分由服务端按天自动发放），所以这条接口
// 对它直接 400，前端也不渲染这个卡片。
//
// **WorkBuddy 2026-11-08 接入**：账本由 `workbuddy/autocheckin.js` 写
// （channel='workbuddy'，只记「签成了」）。上游**不提供签到历史**，所以这个
// 通道只有本地账本 + lastCheckin 两个来源，`note` 如实说明覆盖起点。
// 国际版没有签到接口——但接口不为此 400：账号仍会列出来（用户要看「这个号
// 从来没签过」而不是「页面报错」），由 `unsupportedCheckin` 字段交代。
const accounts = require('../../accounts');
const records = require('../../records');
const ledger = require('../../checkin-ledger');
const { sendJSON } = require('../router');

const CHANNELS = ['dumate', 'traework', 'qoder', 'workbuddy'];

function pad(n) { return String(n).padStart(2, '0'); }
function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
function intIn(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < min || n > max) return dflt;
  return n;
}
function q(req, k) {
  const m = String(req.url || '').match(new RegExp(`[?&]${k}=([^&]*)`));
  return m ? decodeURIComponent(m[1]) : '';
}

/** 原始账号列表（带 cookie / lastCheckin，各通道字段不同） */
function rawAccounts(channel) {
  if (channel === 'dumate') {
    return accounts.load().accounts.filter((a) => a.enabled !== false);
  }
  if (channel === 'traework') {
    return require('../../traework/auth').load().accounts.filter((a) => a.enabled !== false);
  }
  if (channel === 'workbuddy') {
    return require('../../workbuddy/auth').load().accounts.filter((a) => a.enabled !== false);
  }
  return require('../../qoder/auth').load().accounts.filter((a) => a.enabled !== false);
}

function nameOf(channel, a) {
  if (channel === 'dumate') return accounts.displayName(a);
  return a.nickname || a.uid || `账号 ${a.id}`;
}

function lastCheckinOf(channel, a) {
  if (channel === 'dumate') return (a.checkin && a.checkin.last_at) || null;
  return a.lastCheckin || null;
}

const routes = [
  {
    method: 'GET',
    path: '/detail',
    handler: async ({ res, req }) => {
      const channel = q(req, 'channel') || 'dumate';
      if (!CHANNELS.includes(channel)) {
        return sendJSON(res, 400, {
          error: '千问办公没有签到体系：积分由服务端按天自动发放，没有签到或领取接口',
        });
      }

      const now = new Date();
      const year = intIn(q(req, 'year'), 2000, 2100, now.getFullYear());
      const month = intIn(q(req, 'month'), 1, 12, now.getMonth() + 1);
      const today = ledger.dayOf(now.getTime());
      const yearFrom = `${year}-01-01`;
      const yearTo = `${year}-12-31`;
      const monthFrom = `${year}-${pad(month)}-01`;
      const monthTo = `${year}-${pad(month)}-${pad(daysInMonth(year, month))}`;

      const raw = rawAccounts(channel);
      const byId = new Map();
      for (const a of raw) {
        byId.set(Number(a.id), {
          id: a.id,
          name: nameOf(channel, a),
          lastCheckin: lastCheckinOf(channel, a),
          days: {},
        });
      }

      // 合并一条「这天签过」。同一天多来源时保留第一条的 source，
      // 但**积分取第一个非空值**——上游回填的没有金额，领取账本才有。
      const add = (accountId, day, info) => {
        const row = byId.get(Number(accountId));
        if (!row || !day || !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return;
        if (day < yearFrom || day > yearTo) return;
        const prev = row.days[day];
        if (!prev) { row.days[day] = info; return; }
        if (prev.credits == null && info.credits != null) prev.credits = info.credits;
        if (!prev.at && info.at) prev.at = info.at;
        // 上游 sign_in_days 是权威口径：同一天先被本地记录命中时，
        // 仍然把来源升级成 upstream（提示语与界面据此标注）
        if (info.source === 'upstream') prev.source = 'upstream';
      };

      // 1) 本地签到账本（主口径）
      for (const r of ledger.rowsInRange({ channel, fromDay: yearFrom, toDay: yearTo })) {
        add(r.account_id, r.day, {
          source: r.source || 'ledger',
          credits: r.credits == null ? null : r.credits,
          at: r.at || null,
        });
      }

      // 2) 搭子的操作流水：账本上线前的历史只能靠它。只认 ok 的签到
      //    （流水里也有失败尝试，那些不是「签到了」）。
      if (channel === 'dumate') {
        const yearStartMs = new Date(`${yearFrom}T00:00:00`).getTime();
        const { rows } = records.read({ limit: 0, type: 'checkin', since: yearStartMs });
        for (const r of rows) {
          if (!r.ok) continue;
          add(r.account_id, ledger.dayOf(r.ts), {
            source: 'record',
            credits: r.points_delta == null ? null : r.points_delta,
            at: r.ts,
          });
        }
      }

      // 3) Qoder 的领取账本：签到领到的积分批次自带领取时刻
      if (channel === 'qoder') {
        for (const g of require('../../qoder/grants').readAll()) {
          const t = Number(g.grantedAt) || Date.parse(g.grantedAt);
          if (!Number.isFinite(t) || t <= 0) continue;
          add(g.accountId, ledger.dayOf(t), {
            source: 'grant',
            credits: g.amount == null ? null : g.amount,
            at: t,
          });
        }
      }

      // 4) 各账号的 lastCheckin：兜底补最后一天（老数据只有这个）
      for (const a of raw) {
        const t = lastCheckinOf(channel, a);
        if (!t) continue;
        add(a.id, ledger.dayOf(t), { source: 'account', credits: null, at: t });
      }

      // 5) 搭子当月直接问上游（权威），并**回填本地账本**——
      //    上游只给当月，过了这个月就再也查不到了，不回填等于每个月都丢历史。
      let upstream = null;
      if (channel === 'dumate' && year === now.getFullYear() && month === now.getMonth() + 1) {
        const web = require('../../dumate-web');
        upstream = { ok: 0, failed: 0, errors: [] };
        const backfill = [];
        await Promise.all(raw.map(async (a) => {
          try {
            // 出站代理（E 包收口补点）：配置非法走 catch 记失败，不直连
            const info = await web.api.loginBonusInfo(a.cookie, { agent: web.agentFor(a) });
            if (!info.ok) {
              upstream.failed += 1;
              upstream.errors.push({ id: a.id, error: info.error || '查询失败' });
              return;
            }
            upstream.ok += 1;
            for (const d of (info.sign_in_days || [])) {
              const day = String(d);
              if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
              add(a.id, day, { source: 'upstream', credits: null, at: null });
              backfill.push({
                channel, account_id: a.id, account: nameOf(channel, a),
                day, at: new Date(`${day}T12:00:00`).getTime(), source: 'upstream',
              });
            }
          } catch (e) {
            upstream.failed += 1;
            upstream.errors.push({ id: a.id, error: e.message });
          }
        }));
        ledger.appendMany(backfill);
      }

      // 6) 按年汇总：每个月有几天「有人签过」、合计多少个账号·天
      const months = [];
      for (let m = 1; m <= 12; m++) {
        const prefix = `${year}-${pad(m)}-`;
        const days = new Set();
        let accountDays = 0;
        for (const row of byId.values()) {
          for (const d of Object.keys(row.days)) {
            if (!d.startsWith(prefix)) continue;
            accountDays += 1;
            days.add(d);
          }
        }
        months.push({ month: m, days: days.size, accountDays, hasData: accountDays > 0 });
      }

      const accountsOut = [...byId.values()].map((a) => {
        // 同名遮蔽会 TDZ（Cannot access 'raw' before initialization）：
        // 外层已有 const raw = rawAccounts(channel)，这里必须换名
        const rawRow = raw.find((x) => Number(x.id) === Number(a.id));
        // WorkBuddy 国际版没有签到接口（上游明确不支持）：**账号照列**，
        // 但标出来，界面显示「不支持」而不是让人以为「这号一直没签」。
        const wbc = require('../../workbuddy/constants');
        const unsupportedCheckin = channel === 'workbuddy'
          && wbc.normalizeRegion(rawRow && rawRow.region) === 'global';
        return {
          ...a,
          daysInMonth: Object.keys(a.days).filter((d) => d >= monthFrom && d <= monthTo).length,
          checkedToday: !!a.days[today],
          unsupportedCheckin,
          region: channel === 'workbuddy' ? wbc.normalizeRegion(rawRow && rawRow.region) : undefined,
        };
      });

      // 7) 覆盖范围：如实说清「本地从哪天开始有记录」，否则「账本里没有」
      //    会被读成「那天没签到」。
      const cov = ledger.coverage({ channel });
      let since = cov.since;
      // 账号 lastCheckin 也是历史数据点（TRAE 只有它），不能漏进覆盖范围
      for (const row of byId.values()) {
        for (const d of Object.keys(row.days)) {
          if (!since || d < since) since = d;
        }
      }
      if (channel === 'dumate') {
        const { rows } = records.read({ limit: 0, type: 'checkin' });
        for (const r of rows) {
          if (!r.ok) continue;
          const d = ledger.dayOf(r.ts);
          if (!since || d < since) since = d;
        }
      }
      if (channel === 'qoder') {
        for (const g of require('../../qoder/grants').readAll()) {
          const t = Number(g.grantedAt) || Date.parse(g.grantedAt);
          if (!Number.isFinite(t) || t <= 0) continue;
          const d = ledger.dayOf(t);
          if (!since || d < since) since = d;
        }
      }

      const note = channel === 'dumate'
        ? '当月已签日来自上游 sign_in_days（权威）；历史月份来自本地记录，'
          + '本地账本自 ' + (cov.since || '（暂无）') + ' 起记录。'
        : channel === 'qoder'
          ? 'Qoder 上游不提供签到历史；这里合并本地签到账本与积分领取账本'
            + '（领取额，不是剩余额），自 ' + (cov.since || '（暂无）') + ' 起记录。'
          : channel === 'workbuddy'
            ? 'WorkBuddy 上游不提供签到历史；这里的数据来自本地签到账本（由自动/手动'
              + '签到写入，只记「签成了」），自 ' + (cov.since || '（暂无）') + ' 起记录。'
              + '国际版没有签到接口，该区域账号标为「不支持」。'
            : 'TRAE 上游不提供签到历史；这里的数据来自本地签到账本，'
              + '自 ' + (cov.since || '（暂无）') + ' 起记录。';

      return sendJSON(res, 200, {
        channel,
        year,
        month,
        today,
        accounts: accountsOut,
        months,
        coverage: { since: since || null, ledgerSince: cov.since || null },
        upstream,
        note,
      });
    },
  },
];

module.exports = { routes };
