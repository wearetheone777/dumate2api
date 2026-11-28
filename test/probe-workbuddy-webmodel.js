#!/usr/bin/env node
// test/probe-workbuddy-webmodel.js - 免费模型在网页 ACP 通道的 set_model 验证（批次十一探针）
//
// 问题：目录里的免费模型（hy4flash-free，rate 0）能不能被网页沙箱的
// session/set_model 接受？能 → 打卡候选序列免费优先真的省钱；不能 → 序列退回
// flash（现状），白省的是「每天一轮失败的建会话」。
//
// **零计费风险设计**（用户纪律：付费模型使用前必须经同意）：set_model 在
// session/prompt **之前**——set_model 失败就当场删会话、绝不 prompt，会话不跑
// 就不产生任何对话计费；set_model 成功后 prompt 的也是免费模型（rate 0）。
// 会话跑完点亮的是当日网页活跃（与正常打卡同效，不多花一分钱）。
//
// 用法：node test/probe-workbuddy-webmodel.js [model]   # 默认取目录 free 榜首
'use strict';
const webagent = require('../src/workbuddy/webagent');
const authStore = require('../src/workbuddy/auth');

const REGION = process.argv[2] && process.argv[2].startsWith('cn') ? 'cn'
  : process.argv[2] && process.argv[2].startsWith('gl') ? 'global' : null;
const MODEL_ARG = process.argv[2] && !/^(cn|gl)/.test(process.argv[2]) ? process.argv[2] : '';

async function main() {
  const region = REGION || 'cn';
  const accounts = authStore.findUsable().filter((a) => (a.region || 'cn').toLowerCase() === region);
  if (!accounts.length) {
    console.log(`没有 ${region} 可用账号，探针结束`);
    return;
  }
  let model = MODEL_ARG;
  if (!model) {
    const models = require('../src/workbuddy/models');
    const r = await models.fetchModels({ region });
    const free = ((r && r.models) || []).filter((x) => x.free).map((x) => x.id);
    model = free[0] || '';
    console.log(`目录免费模型（${region}）: ${free.join(', ') || '(无)'} → 探针取 ${model || '(没有，退出)'}`);
    if (!model) return;
  }

  for (const account of accounts) {
    const name = account.nickname || account.uid || `账号 ${account.id}`;
    console.log(`\n=== ${name}（${region}, id=${account.id}）model=${model} ===`);
    let agent = null;
    try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) { /* 直连 */ }
    const created = await webagent.createConversation(region, account, { prompt: 'Hi', model });
    if (!created.ok) {
      console.log(`建会话失败: ${created.error}（limit=${created.limit} status=${created.status}）`);
      continue;
    }
    console.log(`会话已建: ${created.id}`);
    const sess = await webagent.getConversationSession(region, account, created.id);
    if (!sess.ok) {
      console.log(`取沙箱失败: ${sess.error} → 删会话`);
      await webagent.releaseConversation(region, account, created.id, { remove: true });
      continue;
    }
    // 连沙箱走到 set_model 为止；失败即删，绝不 prompt
    const channel = new webagent.AcpChannel(sess.link, sess.token, { agent });
    let setOk = false;
    let promptOk = false;
    try {
      await channel.open();
      await channel.request('initialize', { protocolVersion: 1, clientCapabilities: webagent.CLIENT_CAPABILITIES }, 1);
      await channel.request('session/load', { sessionId: sess.sessionId, cwd: sess.cwd || '/workspace', mcpServers: [] }, 2);
      try {
        await channel.request('session/set_model', { sessionId: sess.sessionId, modelId: model }, 3);
        setOk = true;
        console.log('set_model: OK（免费模型被沙箱接受）');
      } catch (e) {
        console.log(`set_model: 失败 → ${e.message} → 删会话，不 prompt（零计费）`);
      }
      if (setOk) {
        await channel.request('session/prompt', { sessionId: sess.sessionId, prompt: [{ type: 'text', text: 'Hi' }] }, 4);
        promptOk = true;
        // 轮询到 completed（上限 90s）
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
          const st = await webagent.conversationStatus(region, account, created.id);
          if (st === 'completed') { console.log('会话完成: completed（免费模型跑通，活跃点亮）'); break; }
          if (st === 'failed' || st === 'error') { console.log(`会话失败: ${st}`); break; }
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    } catch (e) {
      console.log(`ACP 通道异常: ${e.message}`);
    } finally {
      try { channel.close(); } catch (e) { /* 已关 */ }
    }
    // 成功保留（stop），失败删
    const keep = setOk && promptOk;
    const released = await webagent.releaseConversation(region, account, created.id, { remove: !keep });
    console.log(`收尾: ${keep ? 'stop（保留记录）' : 'delete'} → ${released ? 'OK' : '失败'}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
