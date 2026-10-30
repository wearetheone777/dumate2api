// scripts/snapshot-closure.js - 从 src/server.js 重算依赖闭包（stable 快照同步用）
//
// CLAUDE.md 的硬要求：发布快照**必须**从 src/server.js 递归解析 require('./x')
// 算闭包，不能凭直觉、也不能只算子闭包（2026-10-29 的教训：只按 qoder/index.js
// 的 31 文件子闭包比对，结果 server.js 顶层新 require 的 ./boot / ./cors 不在
// 快照里，9080 直接起不来）。
//
// 用法：node scripts/snapshot-closure.js           # 打印闭包（相对路径，排序）
//       node scripts/snapshot-closure.js --json    # 输出 JSON
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// 只跟随相对路径 require（node 内置模块与第三方依赖不参与闭包）
const REQ_RE = /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function resolveRel(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands = [base, base + '.js', path.join(base, 'index.js')];
  for (const c of cands) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function closure(entry) {
  const seen = new Set();
  const missing = [];
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = fs.readFileSync(f, 'utf8');
    REQ_RE.lastIndex = 0;
    let m;
    while ((m = REQ_RE.exec(src)) !== null) {
      const target = resolveRel(f, m[1]);
      if (!target) { missing.push({ from: path.relative(ROOT, f), spec: m[1] }); continue; }
      // 只收 src 目录内的文件（闭包不该越界到 scripts/ 之类）
      if (!target.startsWith(SRC + path.sep) && target !== SRC) continue;
      if (!seen.has(target)) queue.push(target);
    }
  }
  return { files: [...seen].sort(), missing };
}

const { files, missing } = closure(path.join(SRC, 'server.js'));
const rel = files.map((f) => path.relative(SRC, f).split(path.sep).join('/'));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ count: rel.length, files: rel, missing }, null, 2));
} else {
  console.log(`闭包文件数: ${rel.length}`);
  for (const r of rel) console.log('  ' + r);
  if (missing.length) {
    console.log('\n无法解析的相对 require（需人工确认）:');
    for (const m of missing) console.log(`  ${m.from} → ${m.spec}`);
  }
}
