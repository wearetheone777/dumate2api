// src/workbuddy/activity.js - 国内版对话活跃上报（growth 连登）
//
// 复刻自 workbuddy2api-hub 的 wb_accounts.report_activity + wb_tasks
// .build_event('chat') / report_events / fetch_streak_days（2026-11-04 融合，
// 依据该仓库源码与其实测注释）。机制：桌面客户端每次对话都会向 /v2/report
// 上报 chat_request_send 事件，成长体系据此点亮连登/热力墙——设备流登录的
// CLI 账号没有对话就没有活跃，keepalive 每天补一条同形事件。
//
// 上游口径（hub 实测注释，照抄）：
//   · **必须带 userId**，否则服务端 200 但**静默丢弃**；
//   · 每号每天一次即可——不做多时点高频上报（风控口径）；
//   · 判定 = 响应 code === 0；连登天数从 /activity/growth/streak 回读
//     （data.streak.days），读失败不影响上报本身的结论。
//
// 国际版同体系存在（base 是 www.workbuddy.ai），端点跟区域走，不做硬编码。
'use strict';
const crypto = require('crypto');
const c = require('./constants');
const chat = require('./chat');

// 出站注入点（测试打桩用）：默认真实 https.request
let requestImpl = (opts, cb) => require('https').request(opts, cb);
/** @private 测试专用 */
function _setRequestImpl(f) { requestImpl = f; }

/** 构造一条 chat_request_send 事件（形状逐字段对齐 hub build_event('chat')） */
function buildChatEvent(account, model) {
  const now = Date.now();
  const cid = `wb-task-${now}-0`;
  const mid = String((account && account.uid) || '');
  const mId = String((model && model.id) || 'deepseek-v4-flash');
  const mName = String((model && model.name) || 'DeepSeek V4 Flash');
  return {
    eventCode: 'chat_request_send',
    timestamp: now,
    reportDelay: 0,
    mode: 'craft',
    conversationId: cid,
    requestId: `${cid}-req`,
    inputLength: 12,
    requestModelId: mId,
    requestModelName: mName,
    isPlan: false,
    agentName: 'default',
    agentType: 'conversation',
    userId: mid,
  };
}

function headersFor(region, account, bodyLen) {
  // report 不是对话，但上游按同一套身份头识别归属（X-User-Id / X-Domain）；
  // 会话三件套带上无害——桌面客户端真实上报也走同一份 chat 头。
  const convId = chat.stableConversationId([{ role: 'user', content: 'activity-report' }]);
  return chat.chatHeaders(region, account, bodyLen, convId);
}

/**
 * POST {chatBase}/v2/report。
 * @returns {Promise<{ok:boolean, code:number|null, error:string}>}
 */
function reportEvents(region, account, events) {
  return new Promise((resolve) => {
    const spec = c.specOf(region);
    const body = Buffer.from(JSON.stringify(events), 'utf8');
    let agent = null;
    try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
      return resolve({ ok: false, code: null, error: `出站代理配置错误: ${e.message}` });
    }
    const u = new URL(spec.chatBase + '/v2/report');
    const req = requestImpl({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      agent,
      timeout: 15000,
      headers: {
        ...headersFor(region, account, body.length),
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
      },
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (x) => { b += x; });
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          resolve({ ok: j.code === 0, code: j.code != null ? j.code : null, error: j.code === 0 ? '' : `code=${j.code}` });
        } catch (e) {
          resolve({ ok: false, code: null, error: `响应不是 JSON（HTTP ${res.statusCode}）` });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, code: null, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, code: null, error: '上报超时' }); });
    req.write(body);
    req.end();
  });
}

/** 只读查询连登天数。失败返回 null（不发写请求）。 */
function fetchStreakDays(region, account) {
  return new Promise((resolve) => {
    const spec = c.specOf(region);
    let agent = null;
    try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) { /* 读失败按 null */ }
    const u = new URL(spec.chatBase + '/activity/growth/streak');
    const req = requestImpl({
      hostname: u.hostname,
      path: u.pathname,
      method: 'GET',
      agent,
      timeout: 10000,
      headers: headersFor(region, account, 0),
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (x) => { b += x; });
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          const st = (j.data && j.data.streak) || {};
          resolve(typeof st.days === 'number' ? st.days : null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 每日活跃上报（幂等：账号档案 lastActivityReport 是今天就跳过）。
 * @param {object} account 千问风格账号（含 region / accessToken / uid）
 * @param {object} [opts] { authStore } 测试注入
 * @returns {Promise<{ok:boolean, skipped:boolean, streakDays:number|null, msg:string, error:string}>}
 */
async function reportActivity(account, opts = {}) {
  const region = c.normalizeRegion(account && account.region) === 'global' ? 'global' : 'cn';
  const authStore = opts.authStore || require('./auth');
  const prev = String((account && account.lastActivityReport) || '');
  if (prev.startsWith(today())) {
    return { ok: true, skipped: true, streakDays: null, msg: '今日已上报过活跃', error: '' };
  }
  if (!account || !account.uid) {
    // hub 口径：不带 userId 的事件会被静默丢弃——宁可跳过也不白发
    return { ok: false, skipped: false, streakDays: null, msg: '', error: '账号缺 uid，上报会被上游静默丢弃（跳过）' };
  }
  const r = await reportEvents(region, account, [buildChatEvent(account)]);
  if (!r.ok) {
    return { ok: false, skipped: false, streakDays: null, msg: '', error: r.error || '活跃上报被上游拒绝' };
  }
  try { authStore.patch(account.id, { lastActivityReport: `${today()} ${new Date().toTimeString().slice(0, 8)}` }); } catch (e) { /* 记不下不影响结论 */ }
  const days = await fetchStreakDays(region, account);
  return {
    ok: true,
    skipped: false,
    streakDays: days,
    msg: days == null ? '对话活跃上报成功（连登天数未知）' : `对话活跃上报成功（连续打卡 ${days} 天）`,
    error: '',
  };
}

module.exports = { buildChatEvent, reportEvents, fetchStreakDays, reportActivity, _setRequestImpl };
