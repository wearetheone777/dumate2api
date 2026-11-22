// test/unit/tmpdir-helper.test.js - 临时目录自动收尾（防 %TEMP% 越跑越胖）
//
// 背景（2026-11-08 实测）：%TEMP% 里 24 小时内堆了 **3671 个**测试临时目录、
// 242 MB。`fs.mkdtempSync` 只建不删，每次跑全量新增几十个，没人会去数。
// 根因是**默认写法就没有收尾**，不是某几处忘了写 `after()`。
//
// 本用例锁三件事：
//   1. `tmpDir()` 建出来的目录真的存在，且带 `dumate-<tag>-` 前缀（可辨认归属）
//   2. `drop()` 立刻删除且幂等（测试中途清理用）
//   3. **进程退出时会自动清理**——这条最要紧，所以用一个子进程实测，
//      而不是只看代码里 `process.on('exit')` 写没写（写了但不触发等于没有）
//
// 运行：node --test test/unit/tmpdir-helper.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { tmpDir, drop } = require('../helpers/tmpdir');

test('tmpDir：目录存在且带可辨认前缀', () => {
  const dir = tmpDir('helper-check');
  assert.equal(fs.existsSync(dir), true);
  assert.match(path.basename(dir), /^dumate-helper-check-/, '前缀要能看出归属');
  drop(dir);
});

test('drop：删除且幂等（对已删目录再调用不抛）', () => {
  const dir = tmpDir('helper-drop');
  assert.equal(fs.existsSync(dir), true);
  drop(dir);
  assert.equal(fs.existsSync(dir), false);
  assert.doesNotThrow(() => drop(dir));
});

test('同一进程建多个：都各自独立，互不影响', () => {
  const a = tmpDir('multi-a');
  const b = tmpDir('multi-b');
  assert.notEqual(a, b);
  fs.writeFileSync(path.join(a, 'x.txt'), '1', 'utf8');
  assert.equal(fs.existsSync(path.join(b, 'x.txt')), false);
  drop(a);
  drop(b);
});

// 关键用例：子进程退出后目录必须消失。
// 只在 `process.on('exit')` 里写清理是不够的——exit 里不能做异步操作，
// 而 rmSync 是同步的所以能跑；但如果有人把它改成 async 清理就会静默失效。
// 所以这里实跑一遍，而不是读代码。
test('进程退出时自动清理（子进程实测）', () => {
  const out = spawnSync(process.execPath, ['-e', `
    const { tmpDir } = require(${JSON.stringify(path.join(__dirname, '..', 'helpers', 'tmpdir.js'))});
    const d = tmpDir('exit-check');
    require('fs').writeFileSync(require('path').join(d, 'marker.txt'), 'x', 'utf8');
    process.stdout.write(d);
  `], { encoding: 'utf8' });

  assert.equal(out.status, 0, out.stderr);
  const dir = String(out.stdout || '').trim();
  assert.ok(dir, '子进程要回传目录路径');
  assert.equal(fs.existsSync(dir), false,
    `子进程退出后目录应被删除，实际还在：${dir}（清理钩子失效会让 %TEMP% 越跑越胖）`);
});

test('子进程异常退出同样清理（try/finally 之外的那条路）', () => {
  const out = spawnSync(process.execPath, ['-e', `
    const { tmpDir } = require(${JSON.stringify(path.join(__dirname, '..', 'helpers', 'tmpdir.js'))});
    const d = tmpDir('crash-check');
    process.stdout.write(d);
    process.exit(3);
  `], { encoding: 'utf8' });

  const dir = String(out.stdout || '').trim();
  assert.equal(out.status, 3);
  assert.ok(dir);
  assert.equal(fs.existsSync(dir), false, '非 0 退出也要清理');
});
