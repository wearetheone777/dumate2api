// test/verify-workbuddy-accounts-poll.js - 账号页轮询不许打上游（P2-9 修正）
//
// 背景（2026-11-08，本项目自己踩的）：
// P2-9 给账号页加了 15 秒静默轮询，当时轮询直接复用了 `load()`——而 `load()`
// 同时拉 `/status` 与 `/credits`。两者的代价差两个数量级：
//
//   /status   → 读本地 workbuddy-accounts.json（含 restriction 快照），零上游
//   /credits  → **每账号三个上游端点**：签到状态 + 额度 + 按 TTL 的档位
//
// 50 个账号 × 每 15 秒 = 每分钟 200 次上游请求。这正好违反
// `docs/CHANNEL-WORKBUDDY.md` 第 11 条「自动化节奏宁少勿多」——为了一个没人
// 盯着看的数字，主动去撞 11140 风控。
//
// 修法：轮询显式传 `credits: false`。额度只在进页面 / 手动刷新 / 操作后回落
// 时取（那三处本来就该花这个成本）。
//
// 为什么用**读源码**而不是挂载组件跑：组件里有 `App.useApp()`、ant-design-vue
// 的全局注册与 `client` 的 axios 拦截器，为一条「参数传没传」的断言去搭全套
// 挂载环境不划算，而这条不变式恰恰是**字面量形状**（调用点写没写 credits:false），
// 源码断言比行为断言更直接、也更容易在评审时看懂。
//
// 运行：node test/verify-workbuddy-accounts-poll.js
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const COMPONENT = path.join(ROOT, 'web', 'src', 'components', 'workbuddy', 'WorkBuddyAccounts.vue');
const PAGING = path.join(ROOT, 'web', 'src', 'utils', 'paging.ts');

let pass = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function main() {
  console.log('=== WorkBuddy 账号页轮询不打上游 ===\n');

  const src = fs.readFileSync(COMPONENT, 'utf8');

  // ---- 1. 轮询路径必须显式关掉 credits ----
  const pollFn = src.match(/function pollTick\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  ok('存在 pollTick（轮询入口）', !!pollFn);
  if (pollFn) {
    ok('pollTick 调用 load 时传了 credits: false',
      /load\(\s*\{[^}]*credits\s*:\s*false[^}]*\}\s*\)/.test(pollFn[0]),
      pollFn[0].replace(/\s+/g, ' ').slice(0, 120));
    ok('pollTick 是静默的（silent: true）',
      /silent\s*:\s*true/.test(pollFn[0]));
  }

  // ---- 2. 定时器与可见性回调都必须走 pollTick，不许直接 load ----
  const startPoll = src.match(/function startPoll\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  ok('startPoll 的定时器体走 pollTick',
    !!startPoll && /setInterval\(\s*pollTick\s*,/.test(startPoll[0]),
    startPoll ? startPoll[0].replace(/\s+/g, ' ').slice(0, 120) : 'missing');

  const onVis = src.match(/function onVisibility\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  ok('visibilitychange 回调也走 pollTick（不是直连 load）',
    !!onVis && /pollTick\(\s*\)/.test(onVis[0]) && !/\bload\(/.test(onVis[0]),
    onVis ? onVis[0].replace(/\s+/g, ' ').slice(0, 120) : 'missing');

  // ---- 3. 不许有其它「静默但不关 credits」的调用点 ----
  // 静默 = silent: true；这类调用出现在轮询/后台刷新路径上，必须一并关 credits。
  const silentLoads = [...src.matchAll(/load\(\s*\{[^}]*silent\s*:\s*true[^}]*\}/g)]
    .map((m) => m[0].replace(/\s+/g, ' '));
  const badSilent = silentLoads.filter((s) => !/credits\s*:\s*false/.test(s));
  ok('没有「静默但会打上游」的 load 调用点',
    badSilent.length === 0, badSilent.join(' | '));

  // ---- 4. load() 默认仍要取额度（进页面/手动刷新要有数）----
  const loadSig = src.match(/async function load\s*\(\s*opts[^)]*\)/);
  ok('load 的 credits 判据是「默认取」而非「默认不取」',
    !!loadSig && /credits\s*!==\s*false/.test(src),
    loadSig ? loadSig[0] : 'missing');

  // ---- 5. 直接打 /credits 的地方只能是 load（轮询不许绕道） ----
  const creditsCalls = [...src.matchAll(/workbuddyApi\.credits\(/g)];
  ok('workbuddyApi.credits 只在 load 里出现一次', creditsCalls.length === 1,
    `出现 ${creditsCalls.length} 次`);

  // ---- 6. paging.ts 仍然零 Vue 依赖（单测能直接 import 的前提）----
  const pagingSrc = fs.readFileSync(PAGING, 'utf8');
  ok('paging.ts 不 import vue（否则 Node 直测会挂）',
    !/from\s+['"]vue['"]/.test(pagingSrc) && !/require\(\s*['"]vue['"]\s*\)/.test(pagingSrc));

  // ---- 7. 纯函数仍可加载（防止有人给它加 import 把它变成不可测）----
  return (async () => {
    const pg = await import(pathToFileURL(PAGING).href);
    ok('paging.ts 可被 Node 直接 import（类型擦除路径未破）',
      typeof pg.pageSlice === 'function' && typeof pg.sameSig === 'function');

    console.log('');
    if (failures.length) {
      console.log(`${failures.length} 项失败：`);
      for (const f of failures) console.log(`  - ${f}`);
      process.exit(1);
    }
    console.log(`${pass} 项通过，0 项失败`);
  })();
}

main().catch((e) => {
  console.error('验证脚本自身出错：', e);
  process.exit(1);
});
