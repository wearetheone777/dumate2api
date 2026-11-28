// src/admin/routes/usage.js - 用量统计（按模型 / 按密钥 / 按天 + 积分消耗）
//
// 数据来自两处，缺一不可：
//   1. 本地请求日志（data/requests.jsonl）——请求数、Token、模型、密钥
//   2. 上游积分记录（points/records/usage）——真实扣费
//
// 为什么扣费必须问上游：本地只知道「发了多少 token」，不知道
// 「扣了多少积分」——计费规则在上游，模型不同单价不同。日志里算不出来。
const reqlog = require('../../reqlog');
const usageAgg = require('../../usage-agg');
const pointsCache = require('../../points-usage-cache');
const { normalize, belongs, effChannel, LABELS } = require('../../channels');
const { sendJSON } = require('../router');

// 积分记录按账号查，且需要 startAt/endAt（实测缺参数会报
// "参数错误:StartAt"）。结果按账号合并，并附上每个账号的明细。
// **实现只有一份**（points-usage-cache.js，批次二十）：这里委托到共享实现，
// keepalive 的空闲预热与 /overview 的现算走同一段代码——第二份实现必然漂移。
async function pointsUsage(days) {
  const m = await pointsCache.computeWindow(days);
  return { total_consumed: m.total_consumed, total_records: m.total_records, accounts: m.accounts };
}

// 今日消耗单独取（窗口不同，不能从窗口账单推算）
async function pointsTodayUsage() {
  const t = await pointsCache.computeToday();
  return { consumed: t.consumed, records: t.records };
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function clampInt(raw, def, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// 按通道取行。**历史记录（channel 未标注）归入搭子**——分通道埋点上线前
// 只有搭子一条通道，把它们算到「未标注」里，用户切到搭子会看到数字凭空变小，
// 反而比默认成搭子更像在编数据。只有「查看全部」时才单列未标注。
// region（2026-11-03）：'cn'/'intl' 区域视图（只对 traework/qoder/workbuddy
// 有意义）——「国内」包含 region 缺失的历史行，「国际」只看明确 intl 的行。
// **脏数据兜底**：2026-11-03 当天有一段埋点 bug（缺省 region 被判成 intl），
// 245 条国内账号（测150/测157）的行被写成 intl。这里按**账号名回查真实区域**
// 纠偏（账号库是权威来源），否则国际视图会一直挂着国内号的 68M token。
const CH = require('../../channels');
function accountRegionMap(ch, region) {
  if (!region) return null;
  try {
    const store = ch === 'qoder' ? require('../../qoder/auth')
      : ch === 'workbuddy' ? require('../../workbuddy/auth')
        : require('../../traework/auth');
    const list = store.list();
    const out = new Map();
    for (const a of list) {
      const name = a.nickname || a.uid || `账号 ${a.id}`;
      const reg = ch === 'traework'
        ? (String(a.region || '').toLowerCase() === 'intl' ? 'intl' : 'cn')
        : (String(a.region || '').toLowerCase() === 'global' || a.region === 'intl' ? 'intl' : 'cn');
      if (name) out.set(name, reg);
    }
    return out.size ? out : null;
  } catch (e) { return null; }
}

function loadRows(days, ch, region) {
  const since = Date.now() - days * 86400000;
  // 只有带区域概念的通道需要账号名 → 区域映射
  const byName = (ch === 'traework' || ch === 'qoder' || ch === 'workbuddy')
    ? accountRegionMap(ch, region) : null;
  const { rows } = reqlog.read({
    limit: 0,
    filter: (r) => {
      if (r.ts < since) return false;
      if (!CH.belongs(r, ch)) return false;
      if (region && (ch === 'traework' || ch === 'qoder' || ch === 'workbuddy')) {
        // 账号库能查到就以它为准（纠埋点脏数据），查不到才用行内字段
        const fromAccount = byName && r.account ? byName.get(r.account) : undefined;
        const reg = fromAccount || (r.region === 'intl' ? 'intl' : 'cn');
        if (reg !== region) return false;
      }
      return true;
    },
  });
  return rows;
}

// 把一组请求聚合成一行统计
function bucket(rows, keyFn, labelKey) {
  const map = {};
  for (const r of rows) {
    const k = keyFn(r) || '(未知)';
    if (!map[k]) {
      map[k] = { [labelKey]: k, requests: 0, total_tokens: 0, input_tokens: 0, output_tokens: 0, failed: 0, total_ms: 0 };
    }
    const b = map[k];
    b.requests++;
    b.total_tokens += r.total_tokens || 0;
    b.input_tokens += r.input_tokens || 0;
    b.output_tokens += r.output_tokens || 0;
    b.total_ms += r.ms || 0;
    if (r.status >= 400 || r.status === 0) b.failed++;
  }
  return Object.values(map).map((b) => ({ ...b, avg_ms: b.requests ? Math.round(b.total_ms / b.requests) : 0 }));
}

const routes = [
  {
    // 页面主接口：一次给全顶部卡片 + 三张表
    method: 'GET',
    path: '/overview',
    handler: async ({ res, req }) => {
      const days = clampInt((req.url.match(/[?&]days=(\d+)/) || [])[1], 30, 1, 90);
      // 通道筛选：dumate / qwenwork / traework；缺省或未知值 = 全部通道
      const chRaw = decodeURIComponent((req.url.match(/[?&]channel=([^&]*)/) || [])[1] || '');
      const ch = normalize(chRaw);
      // 区域筛选（2026-11-03）：国内/国际独立视图
      const regionRaw = decodeURIComponent((req.url.match(/[?&]region=([^&]*)/) || [])[1] || '').toLowerCase();
      const region = regionRaw === 'cn' || regionRaw === 'intl' ? regionRaw : '';
      const rows = loadRows(days, ch, region);
      const today = dayKey(Date.now());
      const todayRows = rows.filter((r) => dayKey(r.ts) === today);
      // 本周 = 最近 7 天（含今天）
      const weekStart = Date.now() - 7 * 86400000;
      const weekRows = rows.filter((r) => r.ts >= weekStart);

      const sum = (list) => ({
        requests: list.length,
        tokens: list.reduce((s, r) => s + (r.total_tokens || 0), 0),
        failed: list.filter((r) => r.status >= 400 || r.status === 0).length,
      });

      // 积分消耗问上游（本地算不出扣费）。**只有搭子有上游积分账单**——
      // 千问办公的账在自己的池子里（/qwenwork/credits），不查搭子账号池，
      // 否则切到千问会看到搭子的账号消费挂在页面上。
      // 批次二十「统计预热」：命中新鲜缓存直接回（keepalive 空闲时段或上次
      // 页面加载已在后台暖好）；陈旧则现算，同时**后台预热**——先回账再暖，
      // 下一次刷新不再等上游往返。缓存必带时间出仓，前端标注「缓存于」。
      const showPoints = !ch || ch === 'dumate';
      let pointsAll;
      let todayPoints;
      let pointsCacheMeta = null;
      if (showPoints) {
        const v = pointsCache.view(days);
        if (v.window && v.window.fresh && v.today && v.today.fresh) {
          pointsAll = { total_consumed: v.window.total_consumed, total_records: v.window.total_records, accounts: v.window.accounts };
          todayPoints = { consumed: v.today.consumed, records: v.today.records };
          pointsCacheMeta = { cached: true, cached_at: Math.max(v.window.at, v.today.at) };
        } else {
          [pointsAll, todayPoints] = await Promise.all([pointsUsage(days), pointsTodayUsage()]);
          pointsCacheMeta = { cached: false };
          pointsCache.warm(days); // fire-and-forget，失败只留 stderr
        }
      } else {
        pointsAll = { total_consumed: 0, total_records: 0, accounts: [] };
        todayPoints = { consumed: 0, records: 0 };
      }

      // 今日单独算一套更细的指标：顶部卡片要回答「今天跑得怎么样」，
      // 只有请求数与 token 不够——还得知道成功率、快慢、哪些模型在用。
      const okRows = todayRows.filter((r) => r.status >= 200 && r.status < 400);
      const doneRows = todayRows.filter((r) => r.ms);
      const ftRows = todayRows.filter((r) => typeof r.first_token_ms === 'number');

      const todayDetail = {
        ...sum(todayRows),
        success_rate: todayRows.length
          ? Math.round((okRows.length / todayRows.length) * 1000) / 10
          : null,
        avg_ms: doneRows.length
          ? Math.round(doneRows.reduce((s, r) => s + r.ms, 0) / doneRows.length)
          : null,
        // 首字延迟只统计有值的记录——老日志没有这个字段，
        // 把它们当成 0 会把平均值拉低并给出错误的结论
        avg_first_token_ms: ftRows.length
          ? Math.round(ftRows.reduce((s, r) => s + r.first_token_ms, 0) / ftRows.length)
          : null,
        first_token_samples: ftRows.length,
        input_tokens: todayRows.reduce((s, r) => s + (r.input_tokens || 0), 0),
        output_tokens: todayRows.reduce((s, r) => s + (r.output_tokens || 0), 0),
        stream_count: todayRows.filter((r) => r.stream).length,
        // 今日用量按模型拆分，卡片上只标主力
        models: Object.entries(
          todayRows.reduce((m, r) => {
            const k = r.model || '(未知)';
            m[k] = (m[k] || 0) + (r.total_tokens || 0);
            return m;
          }, {})
        ).map(([model, tokens]) => ({ model, tokens }))
          .sort((a, b) => b.tokens - a.tokens),
        consumed_points: showPoints ? todayPoints.consumed : null,
        point_records: showPoints ? todayPoints.records : null,
      };

      // 按天：补齐没有请求的日期，否则折线会把空档连成直线
      const byDay = {};
      for (const r of rows) {
        const k = dayKey(r.ts);
        if (!byDay[k]) byDay[k] = { day: k, requests: 0, total_tokens: 0, failed: 0 };
        byDay[k].requests++;
        byDay[k].total_tokens += r.total_tokens || 0;
        if (r.status >= 400 || r.status === 0) byDay[k].failed++;
      }
      const daily = [];
      for (let i = days - 1; i >= 0; i--) {
        const k = dayKey(Date.now() - i * 86400000);
        daily.push(byDay[k] || { day: k, requests: 0, total_tokens: 0, failed: 0 });
      }

      const byModel = bucket(rows, (r) => r.model, 'model')
        .sort((a, b) => b.total_tokens - a.total_tokens);
      const byKey = bucket(rows, (r) => r.key || (r.key_id ? `key-${r.key_id}` : '未使用密钥'), 'name')
        .sort((a, b) => b.total_tokens - a.total_tokens);

      // 活跃密钥：有实际请求的密钥数量。日志里 key_id=0 表示未启用鉴权，
      // 那种情况下没有「密钥」可言，如实返回 0 而不是编一个。
      const activeKeys = new Set(rows.filter((r) => r.key_id).map((r) => r.key_id)).size;

      // 按通道聚合。关键点：**channel 字段上线前的历史记录归入「未标注」**，
      // 不并入任一通道——默认成 dumate 就是在编数据，会让搭子的历史数字
      // 凭空变大，而用户无从察觉。
      const CH_LABEL = { ...LABELS, untagged: '未标注' };
      const chMap = {};
      for (const r of rows) {
        const id = effChannel(r, ch);
        if (!chMap[id]) chMap[id] = { id, label: CH_LABEL[id] || id, requests: 0, total_tokens: 0, failed: 0, avg_ms: 0, _msSum: 0 };
        const c = chMap[id];
        c.requests++;
        c.total_tokens += r.total_tokens || 0;
        c._msSum += r.ms || 0;
        if (r.status >= 400 || r.status === 0) c.failed++;
      }
      const byChannel = Object.values(chMap)
        .map((c) => ({ ...c, avg_ms: c.requests ? Math.round(c._msSum / c.requests) : 0, _msSum: undefined }))
        .sort((a, b) => b.requests - a.requests);

      // 首字延迟按通道分开：千问首帧实测 6.7s，混进搭子的均值里会让
      // 「平均首字延迟」既偏高又无法归因。
      for (const c of byChannel) {
        const sub = rows.filter((r) => effChannel(r, ch) === c.id && r.first_token_ms != null);
        c.first_token_samples = sub.length;
        c.avg_first_token_ms = sub.length
          ? Math.round(sub.reduce((a, r) => a + r.first_token_ms, 0) / sub.length)
          : null;
      }

      return sendJSON(res, 200, {
        days,
        // 当前通道筛选（'' = 全部）。前端据此决定是否显示「按通道」与积分卡片
        channel: ch,
        // 当前区域筛选（2026-11-03，'' = 未按区域）
        region: region || undefined,
        cards: {
          today: todayDetail,
          week: sum(weekRows),
          consumed: pointsAll.total_consumed,
          consumed_records: pointsAll.total_records,
          active_keys: activeKeys,
          // 主力模型 = 窗口内 token 消耗最多的那个
          top_model: byModel.length ? byModel[0].model : null,
        },
        // 积分账单的缓存元数据：cached=true 时前端标「缓存于 HH:mm」，
        // cached=false 表示刚现算过（后台已重新预热）。非搭子通道为 null
        points_cache: showPoints ? pointsCacheMeta : null,
        daily,
        by_model: byModel,
        by_key: byKey,
        // 已按单通道过滤时不再返回「按通道」——那只会得到一行自己的数据
        by_channel: ch ? [] : byChannel,
        // 各账号的积分消耗，供「按账号」视图。仅搭子有上游账单
        points_by_account: pointsAll.accounts,
        // 说明扣费口径，避免与本地 token 统计混淆
        // 说明扣费口径，避免与本地 token 统计混淆。
        // 直连通道（千问 / TRAE）的账都在各自的池子里，不查搭子的账单。
        note: ch === 'qwenwork'
          ? '千问办公的积分在自己的池子里（见仪表盘的千问积分卡），这里只统计经网关转发的 Token 与请求数。'
          : ch === 'traework'
            ? 'TRAE Work 的积分在自己的池子里（见仪表盘的 TRAE 额度卡），这里只统计经网关转发的 Token 与请求数。'
            : 'Token 与请求数来自本地网关日志；积分消耗来自上游计费记录，两者口径不同（不同模型单价不同）。',
      });
    },
  },
  {
    // 长期用量分桶（施工包 C / GAP F3）：usage-agg 的聚合快照。与 /overview 的
    // 区别是数据源——这里读分桶账本（明细滚走后趋势仍在），不现扫 jsonl。
    // 参数：hours（回看小时数）/ from / to（毫秒）/ channel（精确匹配）。
    method: 'GET',
    path: '/agg',
    handler: ({ res, req }) => {
      const q = (k) => decodeURIComponent((req.url.match(new RegExp(`[?&]${k}=([^&]*)`)) || [])[1] || '');
      const snap = usageAgg.snapshot({
        hours: parseInt(q('hours'), 10) || 0,
        from: Number(q('from')) || 0,
        to: Number(q('to')) || 0,
        channel: q('channel') || '',
      });
      require('../auth').audit('admin', 'usage_agg_read', q('channel') || 'all', `hours=${q('hours') || 'all'}`);
      return sendJSON(res, 200, { ok: true, ...snap });
    },
  },
];

module.exports = { routes, pointsUsage, pointsTodayUsage };
