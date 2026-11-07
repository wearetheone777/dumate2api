// src/admin/routes/metrics.js - Prometheus 文本指标（只读）
//
// 调研 P2-17。数据源是本地请求埋点 requests.jsonl + 通道账号池状态，
// 不打上游、不新增计费。窗口默认最近 24h（?hours= 或 DUMATE_METRICS_WINDOW_MS 覆盖）。
//
// 标签纪律：**只放低基数维度**（channel / model / status / state）。账号 id、
// key id、req_id、IP 一律不进标签——高基数会把 Prometheus 时序撑爆。
const { sendJSON } = require('../router');
const reqlog = require('../../reqlog');
const { CHANNELS } = require('../../channels');
const channelPool = require('../../channel-pool');
const { pool } = require('../../pool');

const WINDOW_MS = Math.max(60000, parseInt(process.env.DUMATE_METRICS_WINDOW_MS || String(24 * 3600 * 1000), 10) || 0);

function esc(v) {
  return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 纯函数：请求行 + 池状态 → Prometheus 文本（离线测试直接喂固定行） */
function render(rows, opts = {}) {
  const grouped = new Map();
  for (const r of rows || []) {
    const k = `${r.channel || 'dumate'}\x00${r.model || 'unknown'}\x00${num(r.status)}`;
    const g = grouped.get(k) || { requests: 0, input: 0, output: 0, errors: 0 };
    g.requests++;
    g.input += num(r.input_tokens);
    g.output += num(r.output_tokens);
    if (num(r.status) >= 400 || !num(r.status)) g.errors++;
    grouped.set(k, g);
  }
  const requestLabels = (k) => {
    const [channel, model, status] = k.split('\x00');
    return `channel="${esc(channel)}",model="${esc(model)}",status="${esc(status)}"`;
  };
  const errorLabels = (k) => {
    const [channel, model] = k.split('\x00');
    return `channel="${esc(channel)}",model="${esc(model)}"`;
  };
  const out = [
    '# HELP dumate2api_requests_total Requests handled by the gateway.',
    '# TYPE dumate2api_requests_total counter',
  ];
  for (const [k, g] of grouped) out.push(`dumate2api_requests_total{${requestLabels(k)}} ${g.requests}`);
  out.push('# HELP dumate2api_tokens_total Tokens reported by upstream responses.', '# TYPE dumate2api_tokens_total counter');
  for (const [k, g] of grouped) {
    out.push(`dumate2api_tokens_total{${requestLabels(k)},direction="input"} ${g.input}`);
    out.push(`dumate2api_tokens_total{${requestLabels(k)},direction="output"} ${g.output}`);
  }
  out.push('# HELP dumate2api_errors_total Failed requests.', '# TYPE dumate2api_errors_total counter');
  const errors = new Map();
  for (const [k, g] of grouped) {
    const ek = k.split('\x00').slice(0, 2).join('\x00');
    errors.set(ek, (errors.get(ek) || 0) + g.errors);
  }
  for (const [k, v] of errors) out.push(`dumate2api_errors_total{${errorLabels(k)}} ${v}`);
  out.push('# HELP dumate2api_accounts Account pool gauge by state.', '# TYPE dumate2api_accounts gauge');
  for (const s of opts.states || []) {
    out.push(`dumate2api_accounts{channel="${esc(s.channel)}",state="${esc(s.state)}"} ${num(s.count)}`);
  }
  return out.join('\n') + '\n';
}

function poolStates() {
  const out = [];
  for (const channel of CHANNELS) {
    let list = [];
    try {
      const store = channel === 'dumate' ? require('../../accounts') : require(`../../${channel}/auth`);
      list = typeof store.list === 'function' ? store.list() : [];
    } catch (e) { /* 通道模块不可用：如实跳过，不编 0 */ }
    const tally = new Map();
    for (const a of list) {
      let state = 'healthy';
      if (a.enabled === false) state = 'disabled';
      else {
        try {
          const uid = channel === 'dumate' ? String(a.id) : channelPool.uidOf(channel, a.id);
          // 只读快照：池没有这个 uid 的记录时不创建空状态（ensure 会写内存状态）
          const st = pool.snapshot().find((x) => String(x.id) === String(uid));
          if (st && st.state) state = String(st.state);
        } catch (err) { /* 池读不到按健康计 */ }
      }
      tally.set(state, (tally.get(state) || 0) + 1);
    }
    for (const [state, count] of tally) out.push({ channel, state, count });
  }
  return out;
}

/** Prometheus 抓取入口：/metrics（根路径）与 /api/admin/metrics 共用同一渲染。
 *  鉴权：配了 DUMATE_METRICS_TOKEN 就必须带 Bearer；未配时根路径允许匿名
 *  （标签只有 channel/model/status/state，无账号 id 等高基数维度）。 */
function handleMetrics(req, res) {
  const token = String(process.env.DUMATE_METRICS_TOKEN || '').trim();
  if (token && String((req.headers && req.headers.authorization) || '') !== `Bearer ${token}`) {
    return sendJSON(res, 401, { error: 'metrics_token_required' });
  }
  const raw = String(req.url || '');
  const hours = parseInt((raw.match(/[?&]hours=(\d+)/) || [])[1] || '0', 10) || 0;
  const since = Date.now() - (hours > 0 ? hours * 3600000 : WINDOW_MS);
  const rows = reqlog.read({ limit: 0, filter: (r) => num(r.ts) >= since }).rows;
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end(render(rows, { states: poolStates() }));
}

const routes = [
  {
    method: 'GET',
    path: '',
    handler: ({ res, req }) => handleMetrics(req, res),
  },
];

module.exports = { routes, render, poolStates, handleMetrics };
