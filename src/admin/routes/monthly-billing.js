// src/admin/routes/monthly-billing.js - 月度账单 + CSV 导出（调研 P2-18）
//
// 与 /billing/reconcile（逐模型实扣对账）不互相替代：这里按
// 月 × 通道 × Key 聚合**经本网关**的请求与 token，回答「谁用了多少」；
// 上游扣了多少积分/credits 不在此表（各通道单位不同，相加没有意义）。
//
// CSV 两道硬纪律：
//   1. UTF-8 BOM：Excel 中文 Windows 默认按 ANSI 打开，不带头会乱码。
//   2. 公式注入：以 = + - @ 开头的单元格加前导单引号；引号双写，
//      逗号/换行用引号包裹。导出文件会被转发，不做这步等于把公式交给
//      打开它的人执行。
const { sendJSON } = require('../router');
const reqlog = require('../../reqlog');
const { CHANNELS } = require('../../channels');

function monthKey(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 纯函数：按月 × 通道 × Key 聚合（离线测试可喂固定行） */
function aggregate(rows, opts = {}) {
  const month = String(opts.month || '');
  const channel = String(opts.channel || '');
  const map = new Map();
  for (const r of rows || []) {
    const mk = monthKey(r.ts);
    if (!mk || (month && mk !== month)) continue;
    const ch = r.channel || 'dumate';
    if (channel && ch !== channel) continue;
    const keyId = String(r.key_id || r.key_name || 'unknown');
    const k = `${mk}\x00${ch}\x00${keyId}`;
    const g = map.get(k) || {
      month: mk, channel: ch, key_id: keyId,
      requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, failed: 0,
    };
    g.requests++;
    g.input_tokens += num(r.input_tokens);
    g.output_tokens += num(r.output_tokens);
    g.total_tokens += num(r.total_tokens);
    if (num(r.status) >= 400 || !num(r.status)) g.failed++;
    map.set(k, g);
  }
  return [...map.values()].sort((a, b) => b.month.localeCompare(a.month)
    || a.channel.localeCompare(b.channel) || a.key_id.localeCompare(b.key_id));
}

function csvCell(v) {
  let s = String(v == null ? '' : v);
  // 前导单引号把公式变成文本；空白前缀也挡住（Excel 会吃掉空格后仍执行）
  if (/^\s*[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const head = ['月份', '通道', 'Key', '请求数', '输入 Token', '输出 Token', '总 Token', '失败数'];
  const lines = [head.join(',')];
  for (const r of rows || []) {
    lines.push([
      r.month, r.channel, r.key_id, r.requests, r.input_tokens,
      r.output_tokens, r.total_tokens, r.failed,
    ].map(csvCell).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

function query(req) {
  const raw = String(req.url || '');
  const q = (k) => decodeURIComponent((raw.match(new RegExp(`[?&]${k}=([^&]*)`)) || [])[1] || '');
  return {
    month: /^\d{4}-\d{2}$/.test(q('month')) ? q('month') : '',
    channel: CHANNELS.includes(q('channel')) ? q('channel') : '',
  };
}

const routes = [
  {
    method: 'GET',
    path: '',
    handler: ({ res, req }) => {
      const { month, channel } = query(req);
      const all = reqlog.read({ limit: 0 }).rows;
      const rows = aggregate(all, { month, channel });
      const months = [...new Set(aggregate(all).map((r) => r.month))].slice(0, 24);
      const totals = rows.reduce((s, r) => ({
        requests: s.requests + r.requests,
        input_tokens: s.input_tokens + r.input_tokens,
        output_tokens: s.output_tokens + r.output_tokens,
        total_tokens: s.total_tokens + r.total_tokens,
        failed: s.failed + r.failed,
      }), { requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, failed: 0 });
      return sendJSON(res, 200, {
        rows, months, month, channel, totals,
        note: '只统计经本网关的请求与 token；上游积分/credits 的单位各通道不同，不在此相加。',
      });
    },
  },
  {
    method: 'GET',
    path: '/export',
    handler: ({ res, req }) => {
      const opts = query(req);
      const rows = aggregate(reqlog.read({ limit: 0 }).rows, opts);
      const body = Buffer.from(toCsv(rows), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="dumate2api-billing-${opts.month || 'all'}.csv"`,
        'Cache-Control': 'no-store',
        'Content-Length': body.length,
      });
      return res.end(body);
    },
  },
];

module.exports = { routes, aggregate, monthKey, csvCell, toCsv };
