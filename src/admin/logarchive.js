// src/admin/logarchive.js - 运行日志的每日 JSONL 归档 + ?days=N ZIP 导出（批次十八）
//
// 与 logbuffer 的分工：内存环只管「看最近」（重启即空），这里管「翻旧账」——
// 每天一份 data/logs/run-YYYY-MM-DD.jsonl，由管理端进程在 sink 里逐行追加。
// 两条纪律沿袭 logbuffer：
//   1. 只收脱敏后的行——sink 挂在 logbuffer.push 之后，敏感行在 entry() 就被
//      整行丢弃，到不了这里；本模块不再自行判断（第二份判据必然漂移）。
//   2. 归档失败吞掉不抛——运行日志不是审计账本，不能拖垮 console 转发。
//
// 零依赖 ZIP：zlib.deflateRawSync + 手写 CRC32 表 + 本地文件头 / 中央目录 /
// EOCD，全部按 PKWARE APPNOTE 手拼。不引第三方包（网关零依赖纪律）。
//
// 跨进程：目前只有管理端进程 install() 了 logbuffer，所以归档只有管理端在
// 写；jsonl.append 本身带跨进程文件锁 + 单次 Buffer 追加，就算将来网关也
// 挂 sink，行与行之间也不会写花。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./store');
const jsonl = require('../jsonl');

const RETENTION_DAYS = 30; // 与「运行日志不是审计账本」一致：翻 30 天足够，再多就该用备份
const RUN_FILE = /^run-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function dirOf() {
  return path.join(store.DATA_DIR, 'logs');
}

function fileFor(dateStr) {
  return path.join(dirOf(), `run-${dateStr}.jsonl`);
}

/** 本地日期串。管理端在本地时区跑，按本地日切分归档。 */
function dateStrOf(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let lastPruneDay = '';
function append(e) {
  if (!e || typeof e.text !== 'string') return; // 形状不对不猜
  const day = dateStrOf(e.ts || Date.now());
  try { fs.mkdirSync(dirOf(), { recursive: true }); } catch (err) { /* 已存在或真失败——后者由 append 的吞错兜底 */ }
  // jsonl.append 只收 string/Buffer，序列化在这里做（与 reqlog 等调用方同一约定）
  jsonl.append(fileFor(day), `${JSON.stringify({ ts: e.ts, level: e.level, ch: e.ch, text: e.text })}\n`);
  // 清理挂在日期翻转上：每天第一条日志触发一次，之后零开销
  if (day !== lastPruneDay) {
    lastPruneDay = day;
    prune();
  }
}

/** 超期归档清理。失败吞掉（目录还没建、文件被占用都只是下次再试）。 */
function prune(now = Date.now()) {
  let names;
  try { names = fs.readdirSync(dirOf()); } catch (e) { return 0; }
  let removed = 0;
  for (const name of names) {
    const m = RUN_FILE.exec(name);
    if (!m) continue;
    const ageDays = (now - Date.parse(`${m[1]}T00:00:00`)) / 86400000;
    if (ageDays > RETENTION_DAYS) {
      try { fs.unlinkSync(path.join(dirOf(), name)); removed++; } catch (e) { /* 下次再试 */ }
    }
  }
  return removed;
}

/** 近 N 天实际存在的归档（新→旧）。days 的合法性由路由层把守。 */
function listDays(days, now = Date.now()) {
  const cut = dateStrOf(now - (days - 1) * 86400000); // YYYY-MM-DD 字典序即时间序
  let names;
  try { names = fs.readdirSync(dirOf()); } catch (e) { return []; }
  const rows = [];
  for (const name of names) {
    const m = RUN_FILE.exec(name);
    if (!m || m[1] < cut) continue;
    let bytes = 0;
    try { bytes = fs.statSync(path.join(dirOf(), name)).size; } catch (e) { continue; }
    rows.push({ date: m[1], file: path.join(dirOf(), name), bytes });
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  return rows;
}

// ---- 零依赖 ZIP ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** DOS 时间（本地时区，2 秒精度——ZIP 格式本身如此）。 */
function dosDateTime(ms) {
  const d = new Date(ms);
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { dosTime, dosDate };
}

/** files: [{name, data(Buffer), mtimeMs?}] → ZIP Buffer。空集产出合法空 ZIP。 */
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const compressed = zlib.deflateRawSync(data);
    // 压不动的（随机内容）退回 stored——方法字段必须与实际载荷一致
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const { dosTime, dosDate } = dosDateTime(f.mtimeMs || Date.now());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags：无 data descriptor，尺寸先知
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra len
    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0, 8);              // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);             // extra len
    cd.writeUInt16LE(0, 32);             // comment len
    cd.writeUInt16LE(0, 34);             // disk number start
    cd.writeUInt16LE(0, 36);             // internal attrs
    cd.writeUInt32LE(0, 38);             // external attrs
    cd.writeUInt32LE(offset, 42);        // local header 偏移
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + payload.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/** 近 N 天归档打包。文件在打包瞬间被清掉就跳过（不猜内容）。 */
function exportZip(days, now = Date.now()) {
  const entries = [];
  for (const f of listDays(days, now)) {
    try {
      entries.push({ name: `run-${f.date}.jsonl`, data: fs.readFileSync(f.file), mtimeMs: fs.statSync(f.file).mtimeMs });
    } catch (e) { /* 刚好被清理 */ }
  }
  return { name: `dumate-logs-${dateStrOf(now)}.zip`, body: buildZip(entries), count: entries.length };
}

/** 挂到 logbuffer 的 sink 上。返回解挂函数。 */
function attach(ring, sink = append) {
  return ring.addSink(sink);
}

module.exports = { RETENTION_DAYS, RUN_FILE, dirOf, fileFor, dateStrOf, append, prune, listDays, exportZip, buildZip, crc32, dosDateTime, attach };
