// src/dumate-web.js - 百度搭子网页端接口封装（签到 / 抽奖 / 任务 / 积分）
//
// 这些接口是网页端（dumate.baidu.com）与桌面端内嵌 H5 共用的一套，
// 从客户端 app.asar 与网页 bundle 里提取，两端常量完全一致：
//
//   base = /api/dumate/activity   (growth_plan_2026)
//     签到      POST /api/dumate/points/loginBonus
//     签到信息  GET  /api/dumate/points/loginBonusInfo
//     抽奖状态  GET  /api/dumate/activity/growth-plan/draw/status
//     抽奖      POST /api/dumate/activity/growth-plan/draw
//     领奖      POST /api/dumate/activity/growth-plan/prize/claim
//     任务列表  GET  /api/dumate/activity/growth-plan/tasks
//     完成任务  POST /api/dumate/activity/growth-plan/task/complete
//     积分明细  GET  /api/dumate/points/quota_overview
//     发放记录  GET  /api/dumate/points/records/charge
//     消耗记录  GET  /api/dumate/points/records/usage
//
// 认证：浏览器同源 cookie（BDUSS 等）。桌面端把请求交给 Go 后端的
// cookie-proxy 转发，我们这里直接带 cookie 请求云端。
const https = require('https');

const BASE = process.env.DUMATE_WEB_BASE || 'https://www.dumate.cn';
const TIMEOUT = parseInt(process.env.DUMATE_WEB_TIMEOUT || '20000', 10);

function request(cookie, method, urlPath, body, opts = {}) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlPath.startsWith('http') ? urlPath : BASE + urlPath);
    } catch (e) {
      return resolve({ ok: false, error: `URL 非法: ${urlPath}` });
    }

    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const headers = {
      Cookie: cookie,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      // 网页端请求带这个头，缺了会被当成非浏览器来源
      'X-Dumate-Client-Type': 'web',
      Referer: BASE + '/app',
      Origin: BASE,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        timeout: TIMEOUT,
        headers,
        // 出站代理（E 包收口补点）：网页端动作（签到/抽奖/任务/积分）与网关
        // 对话同出口——per-account proxy 字段就配在这类账号上，绕过等于白配
        ...(opts.agent ? { agent: opts.agent } : {}),
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch (e) { parsed = null; }
          // 上游用 code 10001 表示登录态失效，单独标出来便于界面提示重新登录
          const expired = res.statusCode === 401 ||
            (parsed && (parsed.code === 10001 || parsed.code === 10006));
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300 && (!parsed || parsed.code === 0 || parsed.success !== false),
            status: res.statusCode,
            expired: !!expired,
            data: parsed,
            raw: parsed ? null : data.slice(0, 300),
          });
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

// 统一取结果体：云端有的包在 result，有的包在 data，有的直接顶层
function pick(res) {
  if (!res.ok) return null;
  const d = res.data;
  if (!d || typeof d !== 'object') return d;
  if ('result' in d) return d.result;
  if ('data' in d) return d.data;
  return d;
}

function errOf(res) {
  if (res.error) return res.error;
  if (res.expired) return '登录态已失效，请重新登录';
  const d = res.data || {};
  return d.message || d.msg || d.error_message || `HTTP ${res.status}`;
}

/**
 * 积分钱包分池（2026-11-15 融合 P0-3，数据面）。
 *
 * 分成三桶，**互不合并**：
 *   dumate        上游明确标了 product:"dumate" 的包
 *   unspecified   上游没给 product 字段的包（多数账号只有这一桶）
 *   others        明确标了其他产品的包（实例：product:"comate"，另一个百度产品
 *                 共用同一钱包——社区实测 5,000 分，被算进搭子余额就是虚报）
 *
 * 另按 `status` 标出可花费的部分：`active`（或上游没给 status）才算；
 * `inactive` 是排队的未来期，计入会成倍虚报。
 *
 * 只做汇总，不改变调用方对 total/used/left 的使用——口径切换要等真机字段核对。
 */
function splitPools(packages) {
  /** 空桶 / 分组累加器。unknown 计数让「不知道」不被写成 0（review #10） */
  const bucket = () => ({ total: 0, used: 0, packs: 0, packsUnknown: 0, partial: false });
  const acc = { dumate: bucket(), unspecified: bucket(), others: [] };
  const otherByIdx = new Map();
  const active = bucket();
  // 缺失 / 空串 / 非数值 → null（**不是 0**）。0 会被下游读成「余额用完」，
  // 与「上游没给这个字段」是两件事（CLAUDE.md：余额 null ≠ 0）。
  const num = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const add = (b, t, u) => {
    b.packs += 1;
    if (t == null || u == null) { b.packsUnknown += 1; b.partial = true; return; }
    b.total += t;
    b.used += u;
  };
  for (const p of Array.isArray(packages) ? packages : []) {
    if (!p || typeof p !== 'object') continue;
    const t = num(p.total);
    const u = num(p.used);
    const spendable = !p.status || p.status === 'active';
    if (spendable) add(active, t, u);
    if (!p.product) {
      add(acc.unspecified, t, u);
    } else if (p.product === 'dumate') {
      add(acc.dumate, t, u);
    } else {
      let row = otherByIdx.get(p.product);
      if (!row) { row = { product: p.product, ...bucket() }; otherByIdx.set(p.product, row); acc.others.push(row); }
      add(row, t, u);
    }
  }
  // left：只有该桶的每个包都读到了数字才给精确值；有一个未知就如实 null
  // （部分和不是余额——把它当余额会在界面上少报，且无法解释差额）。
  const finish = (b) => {
    b.left = b.partial ? null : Math.max(0, b.total - b.used);
    if (b.partial && b.packs === b.packsUnknown) {
      // 整桶都读不到数字：0 是编的，null 才如实
      b.total = null;
      b.used = null;
    }
    return b;
  };
  for (const row of acc.others) finish(row);
  finish(acc.dumate);
  finish(acc.unspecified);
  finish(active);
  acc.active = active;
  acc.note = acc.others.length
    ? 'others 是共用同一钱包的其他产品积分，不可用于搭子模型'
    : (acc.dumate.total ? '' : '上游没有 product 字段，全部落在 unspecified——不要当成搭子专属额度');
  return acc;
}

// 出站 agent 解析（E 包收口补点）：调用方持有**原始账号记录**（load()/getRaw()
// 的元素，proxy 字段全量可用）时用它把本次动作挂到账号自己的代理上。
// 无代理返回 null（直连）；配置非法**抛错**——调用方让本次操作以失败收场，
// 绝不静默回退直连（与 proxy-agent.getAgentFor 同一契约）。
function agentFor(account) {
  return require('./proxy-agent').getAgentFor(account);
}

const api = {
  // ---- 账号信息 ----
  async userInfo(cookie, eopts = {}) {
    const res = await request(cookie, 'GET', '/api/dumate/user/info', undefined, eopts);
    if (!res.ok) return { ok: false, error: errOf(res), expired: res.expired };
    const r = pick(res) || {};
    return { ok: true, uid: r.uid || r.userId || '', nickname: r.nickname || r.displayName || r.name || '', raw: r };
  },

  // ---- 签到 ----
  async loginBonusInfo(cookie, eopts = {}) {
    const res = await request(cookie, 'GET', '/api/dumate/points/loginBonusInfo', undefined, eopts);
    if (!res.ok) return { ok: false, error: errOf(res), expired: res.expired };
    const r = pick(res) || {};
    return {
      ok: true,
      // 上游字段名以实测为准，这里做兼容取值
      has_issued: !!(r.hasIssued ?? r.has_issued),
      total_points: r.totalPoints ?? r.total_points ?? null,
      total_times: r.totalTimes ?? r.total_times ?? null,
      sign_in_days: r.signInDays ?? r.sign_in_days ?? [],
      month_points: r.monthPoints ?? r.month_points ?? null,
      raw: r,
    };
  },

  async claimLoginBonus(cookie, eopts = {}) {
    const res = await request(cookie, 'POST', '/api/dumate/points/loginBonus', undefined, eopts);
    if (!res.ok) return { ok: false, error: errOf(res), expired: res.expired };
    return { ok: true, result: pick(res) };
  },

  // ---- 积分 ----
  //
  // 2026-11-15 融合 P0-3（数据面）：社区 2026-11-13 实测发现 quota_overview 的
  // `totalPoints` 把**别的百度产品**的包也算进来了（他们的账号里有一个 5,000 分
  // 的 `product:"comate"` 包），另外排队的月度授予是 `status:"inactive"`（未来期，
  // 计入会虚报数倍余额）。
  //
  // 本轮**只加字段、不改口径**：顶层 total/used/left 一字不动（既有消费方
  // ——dumate-points 伪模型、额度总览、FEFO 快照——行为零变化），另给
  // `packages[].product/status/points_expire_at` 与 `pools` 分组。
  //
  // 为什么先不改口径：那三个字段名是**别人账号**上的实测，本仓从未在自己账号上
  // 见过（`product` 可能根本不存在）。按「没测到不许写成通过」，先用
  // `node test/probe-dumate-points.js` 落 raw 核对字段名，再动展示——
  // 否则会把「字段不存在」误判成「余额为 0」（CLAUDE.md：余额 null ≠ 0）。
  async quotaOverview(cookie, eopts = {}) {
    const res = await request(cookie, 'GET', '/api/dumate/points/quota_overview?clientType=desktop&timezone=Asia%2FShanghai', undefined, eopts);
    if (!res.ok) return { ok: false, error: errOf(res), expired: res.expired };
    const r = pick(res) || {};
    // 缺失 / 非数值 → null，**不回填 0**（review #10）。0 会被下游读成
    // 「额度用完了」：dumate-points 会报 0 余额、FEFO 会把账号当耗尽、
    // 余额曲线会记一笔假跌破。上游偶发少字段时这是真实会发生的事。
    const num = (v) => {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const total = num(r.totalPoints);
    const used = num(r.usedPoints);
    const left = total != null && used != null ? Math.max(0, total - used) : null;
    const subs = Array.isArray(r.subscription) ? r.subscription : [];
    const incs = Array.isArray(r.incremental) ? r.incremental : [];
    const packages = [].concat(subs, incs).map((p) => {
      const t = num(p.totalPoints);
      const u = num(p.usedPoints);
      return {
        kind: subs.includes(p) ? 'subscription' : 'incremental',
        package_type: p.packageType || '',
        source: p.source || '',
        total: t,
        used: u,
        left: t != null && u != null ? Math.max(0, t - u) : null,
        granted_at: p.startDate ? p.startDate * 1000 : null,
        expire_at: p.expireDate ? p.expireDate * 1000 : null,
        // —— P0-3 新增（上游没给就是空，**不猜成 'dumate'**）——
        product: p.product !== undefined && p.product !== null ? String(p.product) : '',
        status: p.status !== undefined && p.status !== null ? String(p.status) : '',
        // 积分什么时候死（与 expireDate「订阅什么时候到期」是两个口径）
        points_expire_at: p.pointsExpireDate ? Number(p.pointsExpireDate) * 1000 : null,
      };
    });
    return {
      ok: true,
      total,
      used,
      left,
      // 顶层余额是否可信（三个字段要么全有值，要么 left 为 null）。调用方
      // 聚合时据此区分「0」与「不知道」，不必自己判 `left === null`。
      balanceKnown: left != null,
      subscribed: !!r.isSubscribed,
      throttled: !!(r.modelThrottleInfo && r.modelThrottleInfo.throttled),
      packages,
      // 分池汇总。`unspecified` 是「上游没给 product 字段」的那一桶——
      // 与 `dumate` 分开，因为把 unspecified 当 dumate 正是社区那次虚报的成因。
      pools: splitPools(packages),
      raw: r,
    };
  },

  // 积分消耗记录。实测必须带 startAt/endAt，否则报「参数错误:StartAt」。
  // 返回里最有价值的是 consumedPoints（窗口内总扣费）与 totalCount，
  // 计费规则在上游，本地无法从 token 数推算。
  async usageRecords(cookie, opts = {}) {
    const q = new URLSearchParams();
    if (opts.startAt) q.set('startAt', String(opts.startAt));
    if (opts.endAt) q.set('endAt', String(opts.endAt));
    if (opts.page) q.set('page', String(opts.page));
    if (opts.limit) q.set('limit', String(opts.limit));
    const res = await request(cookie, 'GET', '/api/dumate/points/records/usage?' + q.toString(), undefined, { agent: opts.agent });
    if (!res.ok) return { ok: false, error: errOf(res), expired: res.expired };
    const r = pick(res) || {};
    return {
      ok: true,
      consumed_points: r.consumedPoints !== undefined ? Number(r.consumedPoints) : 0,
      total_count: r.totalCount !== undefined ? Number(r.totalCount) : 0,
      list: r.list || [],
    };
  },

  // 积分充值/发放记录。参数同上。
  async chargeRecords(cookie, opts = {}) {
    const q = new URLSearchParams();
    if (opts.startAt) q.set('startAt', String(opts.startAt));
    if (opts.endAt) q.set('endAt', String(opts.endAt));
    if (opts.page) q.set('page', String(opts.page));
    if (opts.limit) q.set('limit', String(opts.limit));
    const res = await request(cookie, 'GET', '/api/dumate/points/records/charge?' + q.toString(), undefined, { agent: opts.agent });
    if (!res.ok) return { ok: false, error: errOf(res), expired: res.expired };
    const r = pick(res) || {};
    return {
      ok: true,
      total_count: r.totalCount !== undefined ? Number(r.totalCount) : 0,
      list: r.list || [],
    };
  },

  // ---- 抽奖 ----
  async drawStatus(cookie, eopts = {}) {
    const res = await request(cookie, 'GET', '/api/dumate/activity/growth-plan/draw/status', undefined, eopts);
    if (!res.ok) return { ok: false, error: errOf(res), expired: res.expired };
    const r = pick(res) || {};
    return {
      ok: true,
      remaining_draws: r.remaining_draws ?? r.remainingDraws ?? 0,
      prizes: r.prizes ?? [],
      my_prizes: r.my_prizes ?? [],
      winning_records: r.winning_records ?? [],
      raw: r,
    };
  },

  // 抽奖需要幂等键：客户端用 randomUUID 生成，服务端据此防重复扣次数。
  // 必须每次生成新的，复用同一个值会让第二次抽奖被当成重复请求。
  async draw(cookie, requestId, eopts = {}) {
    const res = await request(cookie, 'POST', '/api/dumate/activity/growth-plan/draw', {
      request_id: requestId,
    }, eopts);
    if (!res.ok) return { ok: false, error: errOf(res), expired: res.expired };
    const r = pick(res) || {};
    return { ok: true, remaining_draws: r.remaining_draws ?? r.remainingDraws ?? null, result: r };
  },

  // 领奖。注意：实测积分与会员类奖品抽到即 status=SUCCESS，自动到账，
  // 不需要调这个接口；只有需要填联系方式的实物奖品才用得上。
  // 对已 SUCCESS 的记录调用会报「参数错误:DrawRecordID」。
  async claimPrize(cookie, drawRecordId, contact, eopts = {}) {
    const res = await request(cookie, 'POST', '/api/dumate/activity/growth-plan/prize/claim', {
      draw_record_id: drawRecordId,
      ...(contact ? { contact } : {}),
    }, eopts);
    if (!res.ok) return { ok: false, error: errOf(res), expired: res.expired };
    return { ok: true, result: pick(res) };
  },

  // ---- 任务 ----
  // 实测返回结构是 { groups: [{ group_code, group_name, tasks: [...] }] }，
  // 不是平铺数组。任务是否完成看 completed_count >= repeat_count——
  // 这是客户端 completedIds 的判定口径（bundle 里就是这么算的）。
  async tasks(cookie, eopts = {}) {
    const res = await request(cookie, 'GET', '/api/dumate/activity/growth-plan/tasks', undefined, eopts);
    if (!res.ok) return { ok: false, error: errOf(res), expired: res.expired };
    const r = pick(res) || {};
    const groups = Array.isArray(r.groups) ? r.groups : [];
    const flat = [];
    for (const g of groups) {
      for (const t of (g.tasks || [])) {
        flat.push({
          task_id: t.task_id,
          task_type: t.task_type,
          title: t.title,
          sub_title: t.sub_title || '',
          // query 是 QUERY_INPUT 类任务要发的内容；服务端据此校验
          query: t.query || '',
          reward_count: t.reward_count || 0,
          reward_points: t.reward_points || 0,
          repeat_count: t.repeat_count || 1,
          completed_count: t.completed_count || 0,
          done: (t.completed_count || 0) >= (t.repeat_count || 1),
          group_code: g.group_code,
          group_name: g.group_name,
          display_terminal: t.display_terminal || [],
        });
      }
    }
    return { ok: true, groups, tasks: flat };
  },

  async completeTask(cookie, taskId, eopts = {}) {
    const res = await request(cookie, 'POST', '/api/dumate/activity/growth-plan/task/complete', {
      task_id: taskId,
    }, eopts);
    if (!res.ok) return { ok: false, error: errOf(res), expired: res.expired };
    const r = pick(res);
    // 业务层可能返回 success:false + code（如 410121 该任务次数已发放）。
    // 只看 HTTP 状态会把「已发放」当成完成，所以业务码也要判。
    const biz = res.data || {};
    if (biz.success === false || (typeof biz.code === 'number' && biz.code !== 0)) {
      return { ok: false, code: biz.code, error: biz.message || `业务错误 ${biz.code}`, result: r };
    }
    return { ok: true, result: r };
  },

  async pageStatus(cookie, eopts = {}) {
    const res = await request(cookie, 'GET', '/api/dumate/activity/growth-plan/page/status', undefined, eopts);
    if (!res.ok) return { ok: false, error: errOf(res), expired: res.expired };
    return { ok: true, data: pick(res) };
  },
};

module.exports = { BASE, request, pick, errOf, agentFor, splitPools, api };
