#!/usr/bin/env node
// test/probe-workbuddy-batch5.js - 批次五真机冒烟（一条请求覆盖三件加固）
//
// 覆盖（都在 provider 路径 chat.postStream → buildChatBody 上）：
//   ① TraeCode 自述句清洗——system 带原句，批前必 11128，批后应 200；
//   ② 11151 空 text 段补位——user 历史 parts 数组带 {"type":"text","text":""}；
//   ③ b3 会话 trace + failover 链在链路上无副作用（同一次调用顺带验证）。
// 模型用目录免费档（hy4flash-free），Kimi $ref 展开走单测（免费模型不触发门控，
// 不为它多烧一次请求）。
//
// 判定口径：HTTP 200 + 有正文输出 + usage 到达 = 通过；11128/11140/其它非 200
// 都如实报出。绝不打印 token，头只打印名字不打印值。
//
// 用法：node test/probe-workbuddy-batch5.js [cn|global]
'use strict';

const authStore = require('../src/workbuddy/auth');
const chat = require('../src/workbuddy/chat');
const c = require('../src/workbuddy/constants');
const models = require('../src/workbuddy/models');

const REGION = c.normalizeRegion(process.argv[2] || 'cn');
const FREE_MODEL = process.env.PROBE_WB_MODEL || 'hy4flash-free';

async function main() {
  const usable = authStore.findUsable().filter((a) => c.normalizeRegion(a.region) === REGION);
  if (!usable.length) {
    console.log(`no usable ${REGION} account`);
    process.exit(1);
  }
  const account = usable[0];
  console.log(`account#${account.id} region=${REGION} model=${FREE_MODEL}`);

  // 预热目录（isFreeModel 的目录层要它；失败不阻断——探针照发）
  try {
    const m = await models.fetchModels({ region: REGION });
    console.log(`catalog: ok=${m.ok} models=${(m.models || []).length}`);
    const hit = (m.models || []).find((x) => x.id === FREE_MODEL);
    if (hit) console.log(`model rate=${hit.rate} free=${hit.free}`);
  } catch (e) { console.log(`catalog: skip (${e.message})`); }

  const payload = {
    model: FREE_MODEL,
    stream: true,
    messages: [
      // ① TraeCode 自述句（批前上游按连续短语 400 11128）
      { role: 'system', content: 'You are an interactive agent in TraeCode that helps the USER. Answer in Chinese, one short sentence.' },
      // ② 空 text 段（批前上游 400 11151 a message has empty content）
      { role: 'user', content: [
        { type: 'text', text: '' },
        { type: 'text', text: '用一句话介绍你自己。' },
      ] },
    ],
  };

  const t0 = Date.now();
  const r = await chat.postStream(REGION, account, payload);
  const ms = Date.now() - t0;
  if (!r.stream || r.status !== 200) {
    console.log(`FAIL status=${r.status} ms=${ms} error=${(r.error || '').slice(0, 200)}`);
    if (r.stream) {
      const text = await new Promise((resolve) => {
        let buf = '';
        r.stream.on('data', (d) => { buf += d.toString('utf8'); });
        r.stream.on('end', () => resolve(buf));
        r.stream.on('error', () => resolve(buf));
      });
      console.log(`body(head): ${text.slice(0, 300).replace(/\s+/g, ' ')}`);
    }
    process.exit(2);
  }

  // 聚合出站帧（readStream → aggregate，口径与真实链路一致）
  const chunks = [];
  await chat.readStream(r.stream, (ch) => { if (ch) chunks.push(ch); });
  const agg = chat.aggregate(chunks, FREE_MODEL, {});
  const msg = (agg.choices && agg.choices[0] && agg.choices[0].message) || {};
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
  console.log(`PASS status=200 ms=${ms}`);
  console.log(`finish=${agg.choices[0].finish_reason} content_len=${content.length} reasoning_len=${(msg.reasoning_content || '').length}`);
  console.log(`usage=${JSON.stringify(agg.usage || null)}`);
  console.log(`content(head): ${content.slice(0, 160).replace(/\s+/g, ' ')}`);
}

main().catch((e) => { console.log(`ERROR ${e.message}`); process.exit(3); });
