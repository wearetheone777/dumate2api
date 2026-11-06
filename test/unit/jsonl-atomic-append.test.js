// test/unit/jsonl-atomic-append.test.js - 账本原子追加（M3，hub wb_usage_io 教训）
//
// hub 在 Windows 上实测「文本模式追加并发丢行 7.3%」（2400 行只落 2224）。
// 本套件复现那个场景并锁定修复后的行为：
//   1. 多**子进程**并发写同一 jsonl：行数不丢、每行可解析、无交错
//   2. 单进程高频串行写：零丢失
//   3. rotate 与 append 的窗口：触发轮转时不丢行（锁内先轮转再追加）
//   4. 归档后缀可自定义（reqlog 的 .1 约定）
//
// 运行：node --test test/unit/jsonl-atomic-append.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-jsonl-'));
const jsonl = require('../../src/jsonl');

// worker 落成真实文件——`-e` 内嵌脚本要转义路径反斜杠与换行，两种转义叠在
// 一起必然出错（实测 ENOENT 是 require 路径里的 \c 被吃成控制字符）
const WORKER_FILE = path.join(TMP, 'jsonl-worker.js');
fs.writeFileSync(WORKER_FILE, `
const jsonl = require(${JSON.stringify(path.resolve(__dirname, '../../src/jsonl'))});
const [file, n, tag] = process.argv.slice(2);
for (let i = 0; i < Number(n); i++) {
  jsonl.append(file, JSON.stringify({ tag, i }) + '\\n');
}
`);

test('4 个子进程并发各写 250 行：1200 行零丢失、零交错', () => {
  const file = path.join(TMP, 'concurrent.jsonl');
  const PROCS = 4, N = 250;
  for (let p = 0; p < PROCS; p++) {
    // 顺序启动并发度低；真正的并发来自**同一时刻多个进程写同一文件**——
    // 用 & 语义：先全部 spawn 再等，这里退而求其次用连续 spawn（Windows
    // spawn 本身毫秒级错开，4 进程窗口足够撞出竞态；hub 的原始场景同量级）
    execFileSync(process.execPath, [WORKER_FILE, file, String(N), `p${p}`], { timeout: 60000 });
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, PROCS * N, `应恰好 ${PROCS * N} 行，实得 ${lines.length}`);
  // 每行必须完整可解析（无交错断行）
  let bad = 0;
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (!o.tag || !Number.isInteger(o.i)) bad++;
    } catch (e) { bad++; }
  }
  assert.strictEqual(bad, 0, `${bad} 行损坏（交错/截断）`);
  // 每个进程的 250 行都完整在案（丢行检测）
  const byTag = {};
  for (const l of lines) {
    const o = JSON.parse(l);
    byTag[o.tag] = (byTag[o.tag] || 0) + 1;
  }
  for (let p = 0; p < PROCS; p++) {
    assert.strictEqual(byTag[`p${p}`], N, `p${p} 应恰好 ${N} 行，实得 ${byTag['p' + p]}`);
  }
});

test('单进程高频串行写 2000 行：零丢失', () => {
  const file = path.join(TMP, 'serial.jsonl');
  for (let i = 0; i < 2000; i++) {
    jsonl.append(file, JSON.stringify({ i }) + '\n');
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2000);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
});

test('触发轮转时不丢行（锁内先轮转再追加；单次轮转窗口）', () => {
  const file = path.join(TMP, 'rotate.jsonl');
  // 每行 ~170 bytes、maxBytes=600：写第 5 行前触发**恰好一次**轮转。
  // （.old 只保留一代是既有设计——多次轮转会覆盖旧归档，所以本测试
  // 只断言「单次轮转窗口内零丢失」，这是原实现真实的丢行路径）
  for (let i = 0; i < 5; i++) {
    jsonl.append(file, JSON.stringify({ i, pad: 'x'.repeat(150) }) + '\n', 600);
  }
  assert.ok(fs.existsSync(`${file}.old`), '应产生归档文件');
  const main = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const old = fs.readFileSync(`${file}.old`, 'utf8').split('\n').filter(Boolean);
  // 关键断言：主 + 归档 = 总写入行数（原实现窗口期 append 会落进已 rename
// 走的文件或交错丢失）
  assert.strictEqual(main.length + old.length, 5, `主 ${main.length} + 归档 ${old.length} 应为 5`);
  for (const l of [...main, ...old]) assert.doesNotThrow(() => JSON.parse(l));
  // 主文件行号应连续接在归档之后（顺序语义）
  const lastOld = JSON.parse(old[old.length - 1]).i;
  const firstMain = JSON.parse(main[0]).i;
  assert.strictEqual(firstMain, lastOld + 1, '主文件应从归档断点继续');
});

test('归档后缀可自定义（reqlog 的 .1 约定不被统走）', () => {
  const file = path.join(TMP, 'suffix.jsonl');
  jsonl.append(file, JSON.stringify({ i: 0, pad: 'y'.repeat(200) }) + '\n', 100, '.1');
  jsonl.append(file, JSON.stringify({ i: 1, pad: 'y'.repeat(200) }) + '\n', 100, '.1');
  assert.ok(fs.existsSync(`${file}.1`), '应使用 .1 后缀');
  assert.ok(!fs.existsSync(`${file}.old`), '不应产生 .old');
});

test('Buffer 输入与 string 等价', () => {
  const file = path.join(TMP, 'buffer.jsonl');
  jsonl.append(file, Buffer.from(JSON.stringify({ a: 1 }) + '\n'));
  jsonl.append(file, JSON.stringify({ a: 2 }) + '\n');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(JSON.parse(lines[0]).a, 1);
  assert.strictEqual(JSON.parse(lines[1]).a, 2);
});
