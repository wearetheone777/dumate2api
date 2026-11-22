#!/usr/bin/env node
// test/probe-traework-reasoning.js - 只读探测：TRAE 模型表里的「思考档位」形状
//
// 为什么需要它（2026-11-16，调研 P0-4）：要决定「默认思考档」能不能读上游的
// 默认值，必须先看清 descriptor 实际带什么。XCool 的 `/v1/models` 里有个
// `reasoning_default`，但那是**它自己的命名**，不能当我们的字段证据。
//
// **只读**：只打 `get_detail_param`（模型表），不发对话、不消耗积分、
// 不签到、不改任何账号状态。失败也不喂池。
//
// 用法：
//   node test/probe-traework-reasoning.js            # 国内，最多 3 个账号
//   node test/probe-traework-reasoning.js intl       # 国际
//   node test/probe-traework-reasoning.js cn --all   # 全部账号 + 打印每个模型的原始键
'use strict';

const c = require('../src/traework/constants');
const authStore = require('../src/traework/auth');
const models = require('../src/traework/models');
const remote = require('../src/traework/remote');

const args = process.argv.slice(2);
const region = String(args.find((a) => a === 'cn' || a === 'intl') || 'cn');
const all = args.includes('--all');
const LIMIT = all ? 50 : 3;

function keysOf(obj, re) {
  return Object.keys(obj || {}).filter((k) => re.test(k));
}

(async () => {
  const accounts = models.accountsForRegion(region).slice(0, LIMIT);
  if (!accounts.length) {
    console.log(`没有可用的${region === 'intl' ? '国际' : '国内'}账号——这个探针需要至少一个已登录账号。`);
    console.log('（登录：node test/traework-login.js login，或管理端「添加账号」）');
    process.exitCode = 2;
    return;
  }
  console.log(`区域 ${region} · 账号 ${accounts.length} 个（最多 ${LIMIT}）· 只读探测\n`);

  let totalModels = 0;
  let withThinking = 0;
  let withDefaultField = 0;
  const defaultsSeen = [];

  for (const a of accounts) {
    const label = `${a.nickname || a.uid || '账号'} (#${a.id})`;
    let r;
    try {
      r = await models.fetchModels({ region, accountId: a.id, force: true });
    } catch (e) {
      console.log(`${label}: 拉表失败 ${e.message}`);
      continue;
    }
    if (!r.ok) {
      console.log(`${label}: 拉表失败 ${r.error}`);
      continue;
    }
    console.log(`=== ${label} · ${r.models.length} 个模型 · scope=${r.cacheScope} ===`);

    for (const m of r.models) {
      totalModels += 1;
      const raw = m.customModel || {};
      const cfg = remote.reasoningConfigOf(raw);
      const supported = remote.supportedLevels(raw);
      if (!cfg) continue;
      withThinking += 1;

      // descriptor 里所有可能表达「默认档」的字段名（不猜值，只列名）
      const defaultKeys = [
        ...keysOf(cfg, /default|initial|preset|recommend/i).map((k) => `reasoning_effort_config.${k}`),
        ...keysOf(raw, /reasoning_default|default_effort|default_thinking|default_level/i),
      ];
      if (defaultKeys.length) {
        withDefaultField += 1;
        defaultsSeen.push({
          model: m.id, account: a.id,
          fields: defaultKeys.map((k) => {
            const path = k.split('.');
            let v = raw;
            for (const seg of path) v = v && typeof v === 'object' ? v[seg] : undefined;
            return `${k}=${JSON.stringify(v)}`;
          }),
        });
      }

      if (all) {
        console.log(`\n  ${m.id}${m.name && m.name !== m.id ? `（${m.name}）` : ''}`);
        console.log(`    support_thinking=${cfg.support_thinking} options=${JSON.stringify(cfg.options || null)}`);
        console.log(`    支持的档位（归一化后）：${supported.join(' / ') || '（空）'}`);
        console.log(`    reasoning_effort_config 的键：${Object.keys(cfg).join(', ') || '（空）'}`);
        console.log(`    descriptor 顶层与思考相关的键：${keysOf(raw, /reasoning|think|effort|default/i).join(', ') || '（无）'}`);
      }
    }
    console.log('');
  }

  console.log('--- 结论 ---');
  console.log(`模型条目 ${totalModels} 个；其中 ${withThinking} 个带 reasoning_effort_config；`);
  console.log(`带「默认档类字段」的 ${withDefaultField} 个。`);
  if (defaultsSeen.length) {
    console.log('默认档类字段的实际取值：');
    for (const d of defaultsSeen) console.log(`  #${d.account} ${d.model}: ${d.fields.join(' | ')}`);
    console.log('\n→ 有证据：可以考虑直接读上游默认值。');
  } else {
    console.log('\n→ 没有找到「默认档」字段：`defaultReasoning` 只能是我们自己的配置，');
    console.log('  不要按 XCool 的 `reasoning_default` 命名去猜字段（那是它的自定义输出）。');
  }
})();
