// test/helpers/tmpdir.js - 自动收尾的临时目录
//
// 背景（2026-11-08 实测）：%TEMP% 里 24 小时内堆了 **3671 个**测试临时目录、
// 242 MB。根因不是某一处漏写 `after`，而是**默认写法就没有收尾**：
// `fs.mkdtempSync()` 只建不删，每次跑测试新增几十个，谁也不会去数。
//
// 约定：新测试请用 `tmpDir('tag')` 而不是裸 `fs.mkdtempSync`。它在
// `process.on('exit')` 上注册清理，因此：
//   - 不需要每个文件记得写 `after()`（忘了就漏，这正是现状）
//   - `node --test` 每个 .test.js 是独立子进程，退出时必然触发
//   - 断言失败导致提前退出时同样会触发（这是 `after()` 做不到的
//     ——`after` 在部分失败模式下仍会跑，但异常终止就不会）
//
// 保留 `after()` 里的显式清理仍是对的（更早释放），本 helper 只是兜底。
const fs = require('fs');
const os = require('os');
const path = require('path');

// 同一个进程内可能建多个，统一登记
const created = new Set();
let hooked = false;

function hook() {
  if (hooked) return;
  hooked = true;
  const sweep = () => {
    for (const dir of created) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 被锁就留给系统清理 */ }
    }
    created.clear();
  };
  process.on('exit', sweep);
  // 被 Ctrl-C / kill 时也给一次机会（SIGINT 在 Windows 上不一定有，
  // 但 exit 事件仍会触发）
  process.once('SIGINT', () => { sweep(); process.exit(130); });
  process.once('SIGTERM', () => { sweep(); process.exit(143); });
}

/**
 * 建一个会被自动删除的临时目录。
 * @param {string} tag 名称片段（便于在 %TEMP% 里辨认归属）
 * @returns {string} 目录绝对路径
 */
function tmpDir(tag) {
  hook();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dumate-${tag || 'test'}-`));
  created.add(dir);
  return dir;
}

/** 立刻删掉（想在测试中途清理时用）。幂等 */
function drop(dir) {
  created.delete(dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 同上 */ }
}

module.exports = { tmpDir, drop };
