// test/run-all.js - 全量回归聚合器（一条命令跑 unit + 全部离线 verify）
//
// 背景：test/unit/ 40+ 个单测文件、test/verify-* 30+ 个散装脚本，各自手动跑
// 容易漏。本文件把两者串起来，汇总退出码——全绿才算过。
//
// 用法：
//   node test/run-all.js              # 全部离线用例（默认）
//   node test/run-all.js --live       # 追加需要运行中服务的用例（如 verify-ccswitch）
//   node test/run-all.js --only qoder # 只跑名字含 qoder 的 verify 脚本
//
// 设计约束：
//   - 每个脚本独立子进程（各自自带 DUMATE_POOL_STATE 临时文件隔离，互不污染）
//   - 失败才打印输出尾部，全绿时保持一屏可读
//   - 需要真机/运行中服务的脚本进 LIVE 白名单，默认跳过（CI/本地快速回归都安全）
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 默认跳过的脚本（需要运行中的服务或真机账号；--live 时才跑）
const LIVE = new Set([
  'verify-ccswitch.js',   // 打 9080 稳定版网关
]);

const argv = process.argv.slice(2);
const WITH_LIVE = argv.includes('--live');
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? String(argv[onlyIdx + 1] || '') : '';

const PER_SCRIPT_TIMEOUT_MS = 180000;
const PER_UNIT_TIMEOUT_MS = 300000;

function sh(cmd, args, timeoutMs) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function tail(s, n = 30) {
  const lines = String(s || '').split('\n').filter(Boolean);
  return lines.slice(-n).join('\n');
}

let pass = 0;
const failures = [];

function runStep(label, cmd, args, timeoutMs) {
  const t0 = Date.now();
  const r = sh(cmd, args, timeoutMs);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status === 0) {
    pass++;
    console.log(`  ok   ${label} (${secs}s)`);
    return true;
  }
  failures.push(label);
  console.log(`  FAIL ${label}  (exit=${r.status}${r.error ? ' ' + r.error.message : ''})`);
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  console.log(tail(out).split('\n').map((l) => '    | ' + l).join('\n'));
  return false;
}

console.log('=== unit（node --test test/unit/*.test.js）===');
const unitFiles = fs.readdirSync(path.join(ROOT, 'test', 'unit'))
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join('test', 'unit', f));
runStep(`${unitFiles.length} 个单测文件`, process.execPath, ['--test', ...unitFiles], PER_UNIT_TIMEOUT_MS);

console.log('=== verify（离线脚本，逐个跑）===');
const verifyFiles = fs.readdirSync(path.join(ROOT, 'test'))
  .filter((f) => /^verify-.*\.js$/.test(f))
  .filter((f) => (WITH_LIVE ? true : !LIVE.has(f)))
  .filter((f) => !ONLY || f.includes(ONLY))
  .sort();

for (const f of verifyFiles) {
  runStep(f, process.execPath, [path.join('test', f)], PER_SCRIPT_TIMEOUT_MS);
}

console.log(`\n${pass} 项通过，${failures.length} 项失败${failures.length ? '：\n  - ' + failures.join('\n  - ') : ''}`);
process.exit(failures.length ? 1 : 0);
