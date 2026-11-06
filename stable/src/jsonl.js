// src/jsonl.js - 带大小轮转与原子追加的 JSONL 写入（审计 P1-4 + M3 账本原子追加）
//
// 匿名可达的埋点文件（积分游标、各通道积分归因、管理端审计）每请求追加
// 一行，且这些文件会被管理端读路径整文件同步解析——无轮转等于给了匿名者
// 一个「慢性磁盘放大器 + 远程拖慢管理端」的组合。这里统一处理：超上限先
// 把当前文件归档为 `.old`（保留一代，新的 .old 直接覆盖旧的），再追加。
// requests.jsonl 自带 32MB 轮转（reqlog.js，走本模块 maxBytes 参数）。
//
// M3 账本原子追加（2026-11-07，融合 workbuddy2api-hub 的 wb_usage_io 实测教训）：
// hub 在 Windows 上实测「文本模式追加并发丢行 7.3%」（2400 行只落 2224），
// 且**丢行比坏行更危险**——读侧全部 except: continue，被丢的调用既不在
// 请求数里也不在积分合计里，账面直接少一笔还不报错。三件套：
//   1. 整行 Buffer 编码后单次 write——字符串路径经 Node 内部编码可能分片，
//      Buffer 路径 appendFileSync 是单次 WriteFile（Windows FILE_APPEND_DATA
//      语义原子定位末尾，POSIX O_APPEND 同理），别的进程插不进中间
//   2. rotate 与 append 合并进跨进程文件锁——原来的窗口（A stat 未满 →
//      B rotate → A append 进已被 rename 走的 .old）是真实的丢行路径：
//      行写进了 .old，读路径只读主文件
//   3. 写失败留痕不抛——账本不该拖垮请求（既有约定，保持）
const fs = require('fs');
const filelock = require('./filelock');

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function rotateIfNeededLocked(file, maxBytes, archiveSuffix = '.old') {
  try {
    const st = fs.statSync(file);
    if (st.size < maxBytes) return;
    const prev = `${file}${archiveSuffix}`;
    try { fs.unlinkSync(prev); } catch (e) { /* 还没有归档文件 */ }
    // 锁内：rename 与后续 append 的窗口已被互斥，行不会再落进归档文件
    filelock.renameAtomic(file, prev);
  } catch (e) { /* 文件还不存在 */ }
}

function rotateIfNeeded(file, maxBytes = DEFAULT_MAX_BYTES, archiveSuffix = '.old') {
  // 单独导出的兼容入口（测试/工具用）：带锁执行，行为与 append 内部一致
  filelock.withLock(file, () => rotateIfNeededLocked(file, maxBytes, archiveSuffix));
}

/**
 * 追加一行（或多行：调用方拼好的完整 buffer，必须以 \n 结尾）。
 *
 * line 接受 string 或 Buffer。string 内部转 Buffer 后走同一条单次 write 路径；
 * 多行批量（如 checkin-ledger 的合并写）同样安全——原子性以「单次 write」为界，
 * 与行数无关。调用方保证每行自带换行。
 *
 * archiveSuffix：轮转归档的后缀。默认 .old；既有命名约定的文件（如 reqlog 的
 * requests.jsonl.1，reqlog-hook 与管理端读路径都认 .1）传自己的，别被统走。
 */
function append(file, line, maxBytes = DEFAULT_MAX_BYTES, archiveSuffix = '.old') {
  const buf = Buffer.isBuffer(line) ? line : Buffer.from(String(line), 'utf8');
  try {
    filelock.withLock(file, () => {
      rotateIfNeededLocked(file, maxBytes, archiveSuffix);
      fs.appendFileSync(file, buf);
    });
  } catch (e) {
    // 锁超时/磁盘失败：账本丢一笔比拖垮请求路径轻（与散装时代的约定一致，
    // 但现在至少不会静默交错）。留痕到 stderr，别吞得无影无踪。
    try { process.stderr.write(`[jsonl] append failed for ${file}: ${e.message}\n`); } catch (_) { /* stderr 也没了 */ }
  }
}

module.exports = { append, rotateIfNeeded, DEFAULT_MAX_BYTES };
