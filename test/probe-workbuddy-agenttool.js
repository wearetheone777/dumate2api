#!/usr/bin/env node
// test/probe-workbuddy-agenttool.js - agenttool 搜索/抓取 + embeddings 探针
//
// 计划批次八的三条新上游端点（hub + yreidev 双源证据，形状还没在本机验证）：
//   POST {chatBase}/agenttool/v1/search   → title/url/snippet/site/favicon
//   POST {chatBase}/agenttool/v1/webfetch → {url, format:"markdown"}
//   POST {chatBase}/v2/embeddings         → bge-m3（1024 维，与对话两套注册表）
//
// 轻量头集（hub 口径）：Bearer AT + CLI UA，**不带** X-Stainless-*/b3 链路头。
// 禁跟随重定向（Authorization 不能跟着 30x 走）。
// 绝不打印 token；body 只打印前若干字节定形状。
'use strict';

const authStore = require('../src/workbuddy/auth');
const c = require('../src/workbuddy/constants');
const https = require('https');

const REGION = c.normalizeRegion(process.argv[2] || 'cn');

function post(account, path, bodyObj) {
  return new Promise((resolve) => {
    const spec = c.specOf(REGION);
    const u = new URL(spec.chatBase + path);
    const data = JSON.stringify(bodyObj || {});
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${account.accessToken}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
      'User-Agent': c.CLIENT_UA,
    };
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers,
      timeout: 30000,
    }, (res) => {
      // 禁跟随重定向：3xx 直接如实报（hub 口径，防 Authorization 外泄）
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          location: res.headers.location || '',
          contentType: res.headers['content-type'] || '',
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.write(data);
    req.end();
  });
}

function head(s, n = 400) {
  return String(s || '').slice(0, n).replace(/\s+/g, ' ');
}

async function main() {
  const usable = authStore.findUsable().filter((a) => c.normalizeRegion(a.region) === REGION);
  if (!usable.length) { console.log(`no usable ${REGION} account`); process.exit(1); }
  const account = usable[0];
  console.log(`account#${account.id} region=${REGION} chatBase=${c.specOf(REGION).chatBase}`);

  // ---- 1. agenttool/v1/search ----
  console.log('\n== search ==');
  let r = await post(account, '/agenttool/v1/search', { query: '腾讯混元 模型' });
  console.log(`status=${r.status} ct=${r.contentType}`);
  if (r.status >= 300 && r.status < 400) console.log(`redirect → ${r.location} (禁跟随，如实报)`);
  console.log(`body: ${head(r.body)}`);

  // ---- 2. agenttool/v1/webfetch ----
  console.log('\n== webfetch ==');
  r = await post(account, '/agenttool/v1/webfetch', { url: 'https://example.com', format: 'markdown' });
  console.log(`status=${r.status} ct=${r.contentType}`);
  if (r.status >= 300 && r.status < 400) console.log(`redirect → ${r.location} (禁跟随，如实报)`);
  console.log(`body: ${head(r.body)}`);

  // ---- 3. v2/embeddings ----
  console.log('\n== embeddings ==');
  r = await post(account, '/v2/embeddings', { model: 'bge-m3', input: ['hello world'] });
  console.log(`status=${r.status} ct=${r.contentType}`);
  console.log(`body: ${head(r.body)}`);
}

main().catch((e) => { console.log(`ERROR ${e.message}`); process.exit(3); });
