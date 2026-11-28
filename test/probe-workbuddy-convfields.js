#!/usr/bin/env node
// test/probe-workbuddy-convfields.js - 批次十：会话轮级字段 A/B 探针
//
// 证据：misakano conv_fields.go（两版真机抓包同构）——官方把「这一轮属于哪个
// request-id」同时写在头（X-Conversation-Request-ID）与体（最后一条 user 的
// conversationRequestId + startsNewUserRequest:true + agent:'cli'）里。网关
// 之前只写头。本探针单变量对照（红线：body 形状改动必须 A/B 实测）：
//
//   A = buildChatBody 不带 opts（无轮级字段）——基线
//   B = buildChatBody 带 opts.convReqId（字段注入）——实现形态
//
// 判定：两变体都 200 且能看到模型输出才算通过；另验 B 的头体同源
// （body 的 conversationRequestId === 头 X-Conversation-Request-ID）。
// 绝不打印 token；头只打印名字不打印值。
'use strict';

const https = require('https');
const authStore = require('../src/workbuddy/auth');
const chat = require('../src/workbuddy/chat');
const c = require('../src/workbuddy/constants');

const REGION = c.normalizeRegion(process.argv[2] || 'cn');

function sendOnce(headers, body) {
  return new Promise((resolve) => {
    const spec = c.specOf(REGION);
    const u = new URL(spec.chatBase + c.EP_CHAT);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST', headers, timeout: 90000,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { if (buf.length < 12000) buf += d.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode, sample: buf }));
      res.on('error', (e) => resolve({ status: res.statusCode || 0, sample: `STREAM_ERR ${e.message}` }));
    });
    req.on('error', (e) => resolve({ status: 0, sample: `ERR ${e.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, sample: 'ERR timeout' }); });
    req.write(body);
    req.end();
  });
}

function judge(sample) {
  const hit = [];
  for (const [re, name] of [
    [/11128/, '11128 渠道校验'], [/11140/, '11140 风控'],
    [/"code"\s*:\s*"?11101/, '11101 缺头'], [/"code"\s*:\s*"?11151/, '11151 空段'],
    [/"code"\s*:\s*"?11150/, '11150 effort'],
  ]) { if (re.test(sample)) hit.push(name); }
  return hit;
}

/** 首个带 choices 的帧 → 有模型输出；错误帧 → 如实报 */
function outcome(sample) {
  for (const line of sample.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let j;
    try { j = JSON.parse(payload); } catch (e) { continue; }
    if (j.error || (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content)) {
      const ch = j.choices && j.choices[0] && j.choices[0].delta;
      return { ok: !j.error, detail: j.error ? JSON.stringify(j.error).slice(0, 200) : `content=${JSON.stringify((ch && ch.content || '').slice(0, 60))}` };
    }
  }
  return { ok: false, detail: '没有可见输出帧' };
}

async function main() {
  const accounts = authStore.findUsable().filter((a) => c.normalizeRegion(a.region) === REGION);
  if (!accounts.length) { console.error(`no usable ${REGION} account`); process.exit(1); }
  const account = await authStore.ensureFresh(accounts[0]);
  console.log(`account#${account.id} region=${REGION}`);

  const payload = {
    model: process.argv[3] || 'glm-5.3',
    messages: [{ role: 'user', content: '只回复两个字：收到' }],
    max_tokens: 4096,
  };

  // ---- A：无轮级字段（基线）----
  const a = chat.buildChatBody(payload, REGION, account);
  const aBody = JSON.parse(a.body);
  const aLast = aBody.messages[aBody.messages.length - 1];
  console.log(`\n== A 基线（无轮级字段）== last-user extra keys: ${
    Object.keys(aLast).filter((k) => !['role', 'content'].includes(k)).join(',') || '（无）'}`);

  // ---- B：字段注入（实现形态）----
  const reqId = chat.uuidv7hex();
  const b = chat.buildChatBody(payload, REGION, account, { convReqId: reqId });
  const bBody = JSON.parse(b.body);
  const bLast = bBody.messages[bBody.messages.length - 1];
  console.log(`== B 注入 == conversationRequestId=${bLast.conversationRequestId === reqId ? '同源' : '不一致!'} startsNewUserRequest=${bLast.startsNewUserRequest} agent=${bLast.agent}`);

  const h = {
    ...chat.chatHeaders(REGION, account, Buffer.byteLength(b.body), b.convId, b.traceId, { convReqId: reqId }),
    'User-Agent': chat.chatUserAgent(REGION),
  };
  const hb = {
    ...chat.chatHeaders(REGION, account, Buffer.byteLength(a.body), a.convId, a.traceId),
    'User-Agent': chat.chatUserAgent(REGION),
  };
  console.log('header names (both):', Object.keys(h).filter((k) => /Conversation|Request/i.test(k)).join(', '));

  const rb = await sendOnce(h, b.body);
  console.log(`B sent: status=${rb.status}`);
  console.log(`B judge: ${judge(rb.sample).join(', ') || 'clean'}`);
  console.log(`B outcome: ${JSON.stringify(outcome(rb.sample))}`);

  const ra = await sendOnce(hb, a.body);
  console.log(`A sent: status=${ra.status}`);
  console.log(`A judge: ${judge(ra.sample).join(', ') || 'clean'}`);
  console.log(`A outcome: ${JSON.stringify(outcome(ra.sample))}`);

  const bOk = rb.status === 200 && outcome(rb.sample).ok;
  const aOk = ra.status === 200 && outcome(ra.sample).ok;
  const same = bLast.conversationRequestId === reqId;
  console.log(`\nverdict: A=${aOk ? 'PASS' : 'FAIL'} B=${bOk ? 'PASS' : 'FAIL'} 头体同源=${same ? 'OK' : 'BROKEN'}`);
  process.exit(aOk && bOk && same ? 0 : 4);
}

main().catch((e) => { console.error(e); process.exit(3); });
