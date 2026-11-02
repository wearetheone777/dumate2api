// src/admin/routes/reqlogs.js - 请求日志（网关每条转发的原始记录）
//
// 数据源是 data/requests.jsonl（reqlog.record 落盘），一条请求一行：
// 时间、路径、模型（原始/映射后）、状态码、耗时、首字延迟、token、
// 来源 IP、UA、密钥、错误。
//
// 注意与用量统计（usage.js）的分工：那边做聚合（按模型/按天/按密钥），
// 这边只做逐条明细与单条详情——聚合看趋势，明细查个案，互不替代。
const reqlog = require('../../reqlog');
const pointsCursor = require('../../points-cursor');
const accounts = require('../../accounts');
const web = require('../../dumate-web');
const { belongs } = require('../../channels');
const { sendJSON } = require('../router');

function clampInt(raw, def, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * 给千问通道的行附上积分消耗明细。
 *
 * 搭子靠余额游标（points-cursor）算扣费，千问的余额在另一个池子里
 * （qwenwork.cn/user/wallets），所以是两套。这里按 **req_id** 精确配对——
 * 归因要等 1.5s 结算，ts 必然晚于埋点，靠时间猜会把同秒内的请求串账。
 *
 * 分不清「免费 / 付费」时如实留空，而不是归到默认池：
 * 并发请求的差值里可能混了别人的消耗（capture 已标 concurrent）。
 */
function attachQwCredits(rows) {
  const credits = require('../../qwenwork/credits');
  const idx = credits.indexByReqId();
  return rows.map((r) => {
    if (r.channel !== 'qwenwork') return r;
    const c = idx.get(r.req_id);
    if (!c) return r; // 还没结算完 / 采集失败：字段缺省，界面显示「—」
    return {
      ...r,
      // **不再带 qw_free / qw_paid / qw_pool**（2026-11-02）：上游已停止发放
      // 每日免费额度，新记录 free 恒 0、pool 恒 paid，界面按这两列展示只会
      // 显示一排零和同一个标签。历史行里的字段仍在账本里（那是当时的真数据），
      // 只是不再通过接口透出。
      qw_total: c.total,
      // 与相邻请求并发时差值可能含别人消耗，界面要标出来
      qw_concurrent: !!c.concurrent,
      // 请求结束后的余额快照，便于核对
      qw_balance: c.balance || null,
      // 消耗了哪个千问账号。多账号下这就是「这次请求花的谁的钱」——
      // 由 provider 在选号后写进归因记录，与「池里的第一个」不是一回事
      qw_account: c.account || null,
    };
  });
}

/**
 * 给 TRAE Work 通道的行附上真实消耗与**实际使用的账号**。
 *
 * 与千问同理按 req_id 配对（归因要等额度接口返回，ts 必然晚于埋点）。
 * 差别在于 TRAE 是多账号，所以每条都带上是哪个账号花的——
 * 「哪个账号消耗了多少」正是这条通道最要紧的信息。
 */
function attachTwCredits(rows) {
  const credits = require('../../traework/credits');
  return credits.attachCosts(rows);
}

/**
 * 给 Qoder 通道的行附上真实消耗与**实际使用的账号**。
 *
 * 与千问/TRAE 同样按 req_id 配对，但**不做游标差值**：Qoder 的 usage 直接
 * 返回本条请求的 credits，是三条直连通道里唯一能精确归因单条请求的。
 * 所以每条独立有值（首条也有），也不标并发。
 */
function attachQoderCredits(rows) {
  return require('../../qoder/credits').attachCosts(rows);
}

/**
 * 摘掉直连通道行上的搭子余额游标字段。
 *
 * points-cursor 的差值来自**搭子账号**的余额，对直连通道没有意义。
 * 采集端已按通道过滤（server.js 的 logRequest），但历史数据里已经贴错了，
 * 且这里再兜一层——界面宁可显示「—」，也不要显示一个解释不通的数字。
 */
function stripDumateCursor(rows) {
  return rows.map((r) => {
    if (!r.channel || r.channel === 'dumate') return r;
    if (r.points_delta === undefined) return r;
    const { points_delta, points_exact, ...rest } = r;
    return rest;
  });
}

const routes = [
  {
    // 分页列表。最新的在前。
    method: 'GET',
    path: '',
    handler: ({ res, req }) => {
      const q = (k) => (req.url.match(new RegExp(`[?&]${k}=([^&]*)`)) || [])[1];
      const limit = clampInt(q('limit') && decodeURIComponent(q('limit')), 50, 1, 500);
      const offset = clampInt(q('offset') && decodeURIComponent(q('offset')), 0, 0, 10_000_000);
      const days = clampInt(q('days') && decodeURIComponent(q('days')), 7, 1, 90);
      const type = q('status') ? decodeURIComponent(q('status')) : '';
      // 通道筛选：dumate / qwenwork / traework；缺省或未知值 = 全部通道
      const chRaw = q('channel') ? decodeURIComponent(q('channel')) : '';
      const ch = require('../../channels').normalize(chRaw);

      // 过滤语义：all=全部；ok=仅成功（2xx/3xx）；err=仅失败（4xx/5xx/0=中断）
      // 通道语义：历史记录没有 channel 字段，归入搭子——分通道埋点上线前
      // 只有搭子一条通道，单列「未标注」会让用户切到搭子时数字凭空变小。
      const since = Date.now() - days * 86400000;
      const filter = (r) => {
        if (r.ts < since) return false;
        if (!belongs(r, ch)) return false;
        if (type === 'ok') return r.status >= 200 && r.status < 400;
        if (type === 'err') return r.status >= 400 || r.status === 0;
        return true;
      };

      // 一次读全量再切页（审计 P1-5d）：原实现先读一遍取页、再读一遍取
      // 全量窗口做并发判定——整文件同步 JSON.parse 两遍（2×32MB），页面
      // 负载被放大一倍。并发判定要看窗口内全量，不能只看当前页：页外的
      // 请求同样会与页内请求重叠，只看一页会把不准的差值标成准确
      const { rows: allInWindow } = reqlog.read({ limit: 0, filter });
      const total = allInWindow.length;
      const rows = allInWindow.slice(offset, offset + limit);
      return sendJSON(res, 200, {
        // 附上实测扣费（余额差）。没有游标的行如实留空——
        // 第一条请求没有参照点，补 0 会被读成「这条没花钱」
        // 千问/TRAE 的行另按 req_id 附各自的积分明细（三套账，见上面两个 attach）
        rows: attachQoderCredits(attachTwCredits(attachQwCredits(
          stripDumateCursor(pointsCursor.attachCosts(rows, allInWindow)),
        ))),
        total,
        limit,
        offset,
        channel: ch,
        // 提示数据源滚动：日志超 32MB 会轮转，太老的记录可能已被移到 .1
        rotated_file: `${reqlog.LOG_DIR}\\requests.jsonl.1`,
        note: '记录由网关逐条落盘，最多保留 32MB，最老的记录可能已轮转删除。',
      });
    },
  },
  {
    // 上游消费明细（网页端「积分消费记录」的同一份数据）。
    //
    // 与本地请求日志是两套账：本地按「网关转发」记，上游按「实际计费」记，
    // 条数对不上（一次转发可能拆成多笔扣费）。所以这里只做原样呈现，
    // 不与请求日志强行对齐——对齐就是猜。
    //
    // 必须注册在 '/:ts' 之前：路由是锚定整串匹配，'/:ts' 会把
    // 'points-records' 当成 ts 吞掉。
    method: 'GET',
    path: '/points-records',
    handler: async ({ res, req }) => {
      const q = (k) => (req.url.match(new RegExp(`[?&]${k}=([^&]*)`)) || [])[1];
      const days = clampInt(q('days') && decodeURIComponent(q('days')), 7, 1, 90);
      const page = clampInt(q('page') && decodeURIComponent(q('page')), 1, 1, 1000);
      const limit = clampInt(q('limit') && decodeURIComponent(q('limit')), 50, 1, 200);
      const wantId = q('account_id') ? Number(decodeURIComponent(q('account_id'))) : null;

      const now = Math.floor(Date.now() / 1000);
      const startAt = now - days * 86400;
      const list = accounts.load().accounts.filter((a) => a.enabled && (!wantId || a.id === wantId));

      const perAccount = [];
      let totalCount = 0;
      let totalConsumed = 0;

      for (const a of list) {
        // 出站代理（E 包收口补点）：配置非法该账号出错误行，其余账号照常
        let agent;
        try { agent = web.agentFor(a); } catch (e) {
          perAccount.push({ id: a.id, name: accounts.displayName(a), nickname: a.nickname || '', ok: false, error: e.message, rows: [] });
          continue;
        }
        const r = await web.api.usageRecords(a.cookie, { startAt, endAt: now, page, limit, agent });
        if (!r.ok) {
          perAccount.push({ id: a.id, name: accounts.displayName(a), nickname: a.nickname || '', ok: false, error: r.error, rows: [] });
          continue;
        }
        totalCount += Number(r.total_count || 0);
        totalConsumed += Number(r.consumed_points || 0);
        perAccount.push({
          id: a.id,
          name: accounts.displayName(a),
          nickname: a.nickname || '',
          ok: true,
          total_count: Number(r.total_count || 0),
          consumed_points: Number(r.consumed_points || 0),
          rows: (r.list || []).map((it) => ({
            account_id: a.id,
            account: accounts.displayName(a),
            // 上游给的是秒级时间戳，这里统一成毫秒，前端与请求日志同口径
            ts: Number(it.createdAt || 0) * 1000,
            // pointsChange 是字符串且带负号（"-5.58"），转成数值便于排序与着色
            points: Number(it.pointsChange || 0),
            conversation: it.conversationName || '',
            package_id: it.packageId || '',
          })),
        });
      }

      // 合并成一个按时间倒序的流：网页端就是一条时间线，
      // 分账号各列一张表反而看不出「同一时刻哪几笔在一起」
      const merged = perAccount.flatMap((x) => x.rows)
        .sort((a, b) => b.ts - a.ts);

      return sendJSON(res, 200, {
        rows: merged,
        total: totalCount,
        consumed_points: Math.round(totalConsumed * 100) / 100,
        page,
        limit,
        days,
        accounts: perAccount.map(({ rows, ...rest }) => rest),
        note: '数据来自上游计费记录，与本地请求日志不是一一对应：一次转发可能拆成多笔扣费。',
      });
    },
  },
  {
    // 单条详情。按 ts 精确匹配（ms 级时间戳即 id）。
    method: 'GET',
    path: '/:ts',
    handler: ({ res, params }) => {
      const ts = Number(params[0]);
      if (!Number.isFinite(ts)) return sendJSON(res, 400, { error: 'ts 非法' });

      // 不加 limit 的 read 会全量载入解析，897 行没问题，
      // 但日志是滚动的，加 days 限制更稳
      const { rows } = reqlog.read({ limit: 0 });
      const row = rows.find((r) => Number(r.ts) === ts);
      if (!row) return sendJSON(res, 404, { error: '记录不存在（可能已随日志轮转删除）' });
      // 传全量行，并发判定才准（详情页同样要标出「差值可能含别人消耗」）。
      // 与列表接口走**同一条 attach 链**：少一环就会出现「列表显示 TRAE 消耗、
      // 点进详情却是搭子的游标差」这种自相矛盾
      const [withCost] = attachQoderCredits(attachTwCredits(attachQwCredits(
        stripDumateCursor(pointsCursor.attachCosts([row], rows)),
      )));
      return sendJSON(res, 200, withCost);
    },
  },
];

module.exports = { routes };
