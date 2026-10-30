// src/traework/device.js - 设备标识派生
//
// 为什么不能用随机值：**新的 TRAE JWT 会校验设备指纹**。签到这类风控敏感的
// 活动接口只认「与账号匹配的设备标识」，随便编一个会被恒定拒（实测 9074
// 「当前参与用户太多」——那个文案是误导，真相是设备指纹对不上）。
//
// 算法移植自 smart-open/TraeWorkAssistant 的 src-tauri/src/commands/accounts.rs
// （`seeded_stream` / `derive_device`），与它 Python 版 auto_checkin.py 的
// gen=2 同算法：**从 uid 确定性派生**，同一账号每次算出来完全一致。
//
// 三个值各有格式要求，错一个都可能被拒：
//   device_id      15 位数字
//   session_id     64 位十六进制
//   market_user_id UUID v4 格式（8-4-4-4-12）
const crypto = require('crypto');

/**
 * SHA-256 链式取字节流。
 *
 * 把 `salt:seed` 当前缀，反复 `SHA256(prefix || counter_be32)` 拼接，
 * 截断到 nbytes。counter 是大端 32 位，从 0 开始递增。
 *
 * @param {string} seed 派生种子（这里是 uid）
 * @param {string} salt 用途标签（'devid' / 'sess' / 'market'）
 * @param {number} nbytes 需要的字节数
 */
function seededStream(seed, salt, nbytes) {
  const prefix = Buffer.from(`${salt}:${seed}`, 'utf8');
  const chunks = [];
  let counter = 0;
  let total = 0;
  while (total < nbytes) {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter >>> 0, 0);
    const h = crypto.createHash('sha256').update(prefix).update(c).digest();
    chunks.push(h);
    total += h.length;
    counter = (counter + 1) >>> 0;
  }
  return Buffer.concat(chunks).subarray(0, nbytes);
}

/**
 * 从 uid 派生设备三件套。
 *
 * @param {string} uid 账号的 user id（TRAE 的 uid，如 3675042082466132）
 * @param {number} [generation] 派生代数（0 = 原始算法）。9074 实测是
 *   **设备级**而非账号级——同一 token 换一个新派生的 id 就能签到成功
 *   （Trae2api-cn 同结论）。签到撞 9074 时代数 +1 重派生，gen 0 的种子
 *   与原算法完全一致（uid 原样），保证既有账号的设备 id 不漂移。
 * @returns {{deviceId:string, sessionId:string, marketUserId:string}}
 */
function deriveDevice(uid, generation = 0) {
  const g = Number(generation) || 0;
  const seed = g > 0 ? `${String(uid || '')}#${g}` : String(uid || '');
  if (!seed) throw new Error('deriveDevice 需要 uid（设备标识由它派生）');

  // 15 位数字：每字节取模 10 映射到 '0'..'9'
  const deviceId = [...seededStream(seed, 'devid', 15)]
    .map((b) => String.fromCharCode(48 + (b % 10)))
    .join('');

  // 64 位十六进制
  const sessionId = seededStream(seed, 'sess', 32).toString('hex');

  // UUID v4：设版本位（第 7 字节高 4 位 = 4）与变体位（第 9 字节高 2 位 = 10）
  const m = Buffer.from(seededStream(seed, 'market', 16));
  m[6] = (m[6] & 0x0f) | 0x40;
  m[8] = (m[8] & 0x3f) | 0x80;
  const hex = m.toString('hex');
  const marketUserId = [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32),
  ].join('-');

  return { deviceId, sessionId, marketUserId };
}

module.exports = { deriveDevice, seededStream };
