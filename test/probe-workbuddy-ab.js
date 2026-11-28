#!/usr/bin/env node
// test/probe-workbuddy-ab.js - WorkBuddy P0-1/P0-2 出站形态 A/B 对照探针
//
// 11.4 批的先例教训：「无害」要用严格 A/B 证明，不能用「没报错」代替。
// 本探针把同一份最小对话发给真实上游三次，每次只差一个变量：
//   A = 现行代码原样（chatHeaders + chatUserAgent + buildChatBody）——基线
//   B = 官方对齐头集（探针内联实现）+ 现行正文 —— 头部单变量
//   C = 官方对齐头集 + 官方 body 字段（cache_retention / extra_vars /
//       reasoning_summary / uuidv7 会话 id）—— P0-1 + P0-2 合并预演
//
// 判定口径：11128（渠道校验）/ 11140（风控）/ 其它非 200 都算「该变体引入了
// 问题」；三变体都是 200 且都能看到模型输出才算通过。**绝不打印 token，
// 头只打印名字不打印值。**
//
// 用法：node test/probe-workbuddy-ab.js [cn|global]
const https = require('https');
const crypto = require('crypto');
const authStore = require('../src/workbuddy/auth');
const chat = require('../src/workbuddy/chat');
const c = require('../src/workbuddy/constants');
const models = require('../src/workbuddy/models');

const REGION = c.normalizeRegion(process.argv[2] || 'cn');
const MODEL_ARG = String(process.argv[3] || '').trim(); // 指定模型（默认目录第一个 free）
const CLI_VERSION = '2.176.0';
const STAINLESS = {
  'X-Stainless-Retry-Count': '0',
  'X-Stainless-Timeout': '1200',
  'X-Stainless-Lang': 'js',
  'X-Stainless-Package-Version': '6.25.0',
  'X-Stainless-OS': 'MacOS',
  'X-Stainless-Arch': 'arm64',
  'X-Stainless-Runtime': 'node',
  'X-Stainless-Runtime-Version': 'v22.21.1',
};

/** uuidv7 形状的 32-hex（时间有序前缀，正式实现进 chat.js） */
function uuidv7hex(now = Date.now()) {
  const buf = crypto.randomBytes(16);
  const t = Math.floor(now);
  buf[0] = Math.floor(t / 2 ** 40) & 0xff;
  buf[1] = Math.floor(t / 2 ** 32) & 0xff;
  buf[2] = Math.floor(t / 2 ** 24) & 0xff;
  buf[3] = Math.floor(t / 2 ** 16) & 0xff;
  buf[4] = Math.floor(t / 2 ** 8) & 0xff;
  buf[5] = t & 0xff;
  buf[6] = 0x70 | (buf[6] & 0x0f);
  buf[8] = 0x80 | (buf[8] & 0x3f);
  return buf.toString('hex');
}

/** 与 stableConversationId 同源的种子 → uuidv7 形状的稳定会话 id */
function stableUuidV7(messages) {
  const first = Array.isArray(messages) ? messages.find((m) => m && m.role === 'user') : null;
  const text = first ? JSON.stringify(first.content ?? first) : '';
  const seed = text
    ? crypto.createHash('sha256').update(text).digest('hex').slice(0, 32)
    : uuidv7hex();
  const s = seed.toLowerCase().padEnd(32, '0').slice(0, 32);
  const y = (0x8 | (parseInt(s[16], 16) & 0x3)).toString(16);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-7${s.slice(13, 16)}-${y}${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

/** 官方对齐头集（P0-1 计划形态；与探针内联、与正式实现分开双写以交叉验证） */
function officialHeaders(region, account, bodyLen, convId, clientVersion) {
  const product = region === 'global' ? 'workbuddy-ai' : 'WorkBuddy';
  const msgId = uuidv7hex();
  const convReqId = uuidv7hex();
  const traceId = uuidv7hex();
  const spanId = crypto.randomBytes(8).toString('hex');
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Content-Length': String(bodyLen),
    Authorization: `Bearer ${(account && account.accessToken) || ''}`,
    'User-Agent': `${product}/${clientVersion} ${product}/${clientVersion} CLI/${CLI_VERSION}`,
    'X-Product': 'SaaS',
    'X-Agent-Purpose': 'conversation',
    'X-Agent-Intent': 'craft',
    'X-Agent-Type': 'main',
    'X-Agent-Runtime': 'local-agent',
    'X-Private-Data': 'true',
    'X-Client-Version': clientVersion,
    'X-Client-Platform': 'macos',
    'X-Client-Product': product,
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': clientVersion,
    ...STAINLESS,
    'X-Conversation-ID': convId,
    'X-Conversation-Request-ID': convReqId,
    'X-Conversation-Message-ID': msgId,
    // cn 官方 X-Request-ID 镜像 Conversation-Request-ID；intl 镜像 Message-ID
    'X-Request-ID': region === 'global' ? msgId : convReqId,
    // 分歧带：保持现状（X-Root-Request-ID / X-CodeBuddy-Request）
    'X-Root-Request-ID': msgId,
    'X-CodeBuddy-Request': '1',
    'X-Trace-ID': traceId,
    traceparent: `00-${traceId}-${spanId}-01`,
    b3: `${traceId}-${spanId}-1`,
    'X-B3-TraceId': traceId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',
  };
  if (account && account.uid) h['X-User-Id'] = String(account.uid);
  if (account && account.enterpriseId) h['X-Enterprise-Id'] = String(account.enterpriseId);
  if (account && account.domain) h['X-Domain'] = String(account.domain);
  return h;
}

/** 官方 body 字段预演（P0-2 计划形态） */
function officialBody(bodyJson) {
  const body = JSON.parse(bodyJson);
  if (body.cache_retention === undefined) body.cache_retention = 'long';
  const ev = (body.extra_vars && typeof body.extra_vars === 'object') ? body.extra_vars : (body.extra_vars = {});
  if (ev.harnessMetadata === undefined) {
    ev.harnessMetadata = JSON.stringify({
      schemaVersion: 1,
      harnessVersion: CLI_VERSION,
      stepIndex: 0,
      agent: { depth: 0 },
    });
  }
  const last = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : null;
  if (ev.initiator === undefined && last && last.role === 'user') ev.initiator = 'user';
  if (body.reasoning_summary === undefined) body.reasoning_summary = 'auto';
  body.conversation_id = stableUuidV7(body.messages);
  return { body: JSON.stringify(body), convId: body.conversation_id };
}

function sendOnce(spec, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(spec.chatBase + c.EP_CHAT);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST', headers, timeout: 90000,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { if (buf.length < 8000) buf += d.toString('utf8'); });
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
  if (/11128/.test(sample)) hit.push('11128');
  if (/11140/.test(sample)) hit.push('11140');
  if (/"code"\s*:\s*"?1115[01]/.test(sample)) hit.push('11150/11151');
  if (/"code"\s*:\s*"?11101/.test(sample)) hit.push('11101');
  return hit;
}

function firstDataLine(sample) {
  const m = /data:\s*(\{.{0,220})/.exec(sample);
  return m ? m[1] : sample.slice(0, 220);
}

async function main() {
  const spec = c.specOf(REGION);
  const accounts = authStore.findUsable().filter((a) => c.normalizeRegion(a.region) === REGION);
  if (!accounts.length) {
    console.error(`no usable ${REGION} account`);
    process.exit(1);
  }
  const account = await authStore.ensureFresh(accounts[0]);
  const clientVersion = (process.env.DUMATE_WORKBUDDY_APP_VERSION || '').trim()
    || spec.fallbackAppVersion;

  // 模型：优先目录里第一个 free 的，否则第一个；目录拉不动回落 glm-5.3
  let model = MODEL_ARG || 'glm-5.3';
  if (!MODEL_ARG) {
    try {
      const r = await models.fetchModels({ region: REGION });
      if (r.ok && r.models && r.models.length) {
        const free = r.models.find((m) => m.free) || r.models[0];
        model = free.id;
      }
    } catch (e) { /* 回落静态名 */ }
  }

  const payload = { model, messages: [{ role: 'user', content: '你好' }], max_tokens: 32 };
  const a = chat.buildChatBody(payload, REGION, account);
  const aHeaders = {
    ...chat.chatHeaders(REGION, account, Buffer.byteLength(a.body), a.convId),
    'User-Agent': chat.chatUserAgent(REGION),
  };
  const cBody = officialBody(a.body);

  const variants = [
    { name: 'A(current)', headers: aHeaders, body: a.body, convId: a.convId },
    { name: 'B(new-headers)', headers: officialHeaders(REGION, account, Buffer.byteLength(a.body), a.convId, clientVersion), body: a.body, convId: a.convId },
    { name: 'C(new-headers+new-body)', headers: officialHeaders(REGION, account, Buffer.byteLength(cBody.body), cBody.convId, clientVersion), body: cBody.body, convId: cBody.convId },
  ];

  // --real：只走**真实代码路径**（chat.postStream，P0 全链路），聚合看 reasoning
  if (process.argv.includes('--real')) {
    const r = await chat.postStream(REGION, account, payload);
    if (r.status >= 400) {
      let t = '';
      try { for await (const d of r.stream) t += d.toString('utf8'); } catch (e) { t = e.message; }
      console.log(`[D(real-code)] status=${r.status} FAIL: ${t.slice(0, 300)}`);
      process.exit(1);
    }
    const chunks = [];
    await chat.readStream(r.stream, (ch) => { if (ch) chunks.push(ch); });
    const agg = chat.aggregate(chunks, model, {});
    const msg = (agg.choices && agg.choices[0] && agg.choices[0].message) || {};
    console.log(`[D(real-code)] status=${r.status} convId=${r.convId}`);
    console.log(`  headers sent: ${Object.keys(r.reqHeaders).length}`);
    console.log(`  finish=${agg.choices[0].finish_reason} content=${JSON.stringify((msg.content || '').slice(0, 80))}`);
    console.log(`  reasoning_len=${(msg.reasoning_content || '').length} usage=${JSON.stringify(agg.usage)}`);
    console.log(`  verdict: ${(msg.content || '').length || (msg.reasoning_content || '').length ? 'PASS' : 'FAIL(empty)'}`);
    return;
  }

  console.log(`region=${REGION} model=${model} account=${account.id}`);
  for (const v of variants) {
    const names = Object.keys(v.headers).sort();
    const r = await sendOnce(spec, v.headers, v.body);
    const bad = judge(r.sample);
    const hasContent = /"delta"|"content"/.test(r.sample);
    console.log(`\n[${v.name}] status=${r.status} convId=${v.convId}`);
    console.log(`  headers(${names.length}): ${names.join(' ')}`);
    console.log(`  first: ${firstDataLine(r.sample).replace(/\s+/g, ' ')}`);
    console.log(`  verdict: ${r.status === 200 && hasContent && !bad.length ? 'PASS' : `FAIL${bad.length ? ' hit=' + bad.join(',') : ''} content=${hasContent}`}`);
    await new Promise((res) => setTimeout(res, 1500));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
