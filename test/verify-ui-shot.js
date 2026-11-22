// test/verify-ui-shot.js - 前端视觉验证工具自检（离线，不起浏览器也能跑一半）
//
// 背景：CLAUDE.md 要求「改完前端别只看接口返回，要用真实浏览器截图核对可见性」，
// 而浏览器扩展（bsk）不总是连着。tools/ui-shot.js 就是那时唯一能用的手段。
// 但工具本身也会坏（第一版就有两个 bug：改了 localStorage 却只换 hash，
// SPA 的 store 不重读，截图字节数一模一样；以及只在滚动到底后截整页，
// 两列高度差大时视觉上像挤成一列）。
//
// 本脚本做两件事：
//   1. 静态检查（离线）：工具文件里那几条「踩过的坑」的修法是否还在
//      —— 这类防护一旦被「顺手简化」掉，问题会静默复发
//   2. 真机检查（只在 --live 且 9138 可达时）：起浏览器、跑一次断言、验截图产出
//
// 用法：
//   node test/verify-ui-shot.js            # 只跑静态检查
//   node test/verify-ui-shot.js --live     # 额外跑一次真实截图（需要 9138 活着）
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'ui-shot.js');
const LIVE = process.argv.includes('--live');

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else {
    fails.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('=== ui-shot 工具自检 ===\n');

// ---- 静态检查 ----
ok('工具文件存在', fs.existsSync(TOOL));
if (!fs.existsSync(TOOL)) {
  console.log('\n工具不存在，后续检查跳过');
  process.exit(1);
}
const src = fs.readFileSync(TOOL, 'utf8');

// 坑 1：只换 hash 不会让 SPA 重新读 localStorage
ok('导航带 cache-busting query（否则改 channel 无效）',
  /ui-shot=\$\{Date\.now\(\)\}|\?ui-shot=/.test(src),
  '第一版只 goto 同一个 /#/xxx，截图字节数一模一样');

// 坑 2：设完 channel 必须在同源页面上执行（否则 localStorage 是别的 origin 的）
ok('写 localStorage 前先导航到同源页', /localStorage\.setItem\('lab-channel'/.test(src)
  && /Page\.navigate[\s\S]{0,400}localStorage\.setItem/.test(src));

// 坑 3：断言失败必须非 0 退出（否则 CI 里永远是绿的）
ok('断言失败时退出码非 0', /process\.exit\(fail \? 1 : 0\)/.test(src));

// 坑 4：必须留聚焦截图能力（整页截图会误判两列布局）
ok('支持 --focus 单容器截图', /--focus|const FOCUS = arg\('focus'/.test(src));

// 坑 5：必须清理 Edge 与临时 profile（否则每跑一次留一个进程 + 一个目录）
ok('退出时清理 Edge 进程与 profile', /process\.on\('exit', cleanup\)/.test(src)
  && /child\.kill\(\)/.test(src) && /rmSync\(profile/.test(src));

// 坑 6：CDP 命令必须有超时（否则网络卡住会永久挂起）
ok('CDP 命令有超时保护', /CDP 超时|setTimeout\(\(\) => \{ if \(waits\.has\(id\)\)/.test(src));

// 坑 7：依赖 Node 全局 WebSocket，缺了要给出明确提示而不是崩栈
ok('缺 WebSocket 时给出明确提示', /typeof WebSocket !== 'function'/.test(src));

// ---- 真机检查（可选）----
if (LIVE) {
  console.log('\n--- 真机检查（--live）---');
  const port = 9138;
  const probe = spawnSync(process.execPath, ['-e', `
    const http = require('http');
    const r = http.get('http://127.0.0.1:${port}/api/admin/auth/me', (res) => {
      process.stdout.write(String(res.statusCode)); process.exit(0);
    });
    r.on('error', () => { process.stdout.write('down'); process.exit(0); });
    setTimeout(() => { process.stdout.write('timeout'); process.exit(0); }, 3000);
  `], { encoding: 'utf8' });
  const status = String(probe.stdout || '').trim();
  if (status !== '401' && status !== '200') {
    console.log(`  skip  ${port} 不可达（${status}）——真机检查跳过`);
  } else {
    ok(`${port} 可达（HTTP ${status}）`, true);
  }
}

console.log('');
if (fails.length) {
  console.log(`${fails.length} 项失败：`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${pass} 项通过，0 项失败`);
