// test/verify-traework-9074.js - 9074 自愈闭环的离线验证（2026-10-30）
//
// 不依赖网关/上游：打桩 constants.request（按端点与请求头里的 X-Device-Id
// 分发预设响应），auth 落盘隔离到临时目录（DUMATE_ADMIN_DATA）。
//
// 背景：9074「当前参与用户太多」实测是**设备级**校验而非账号级——同一
// token 换一个新派生的设备 id 就能签到成功（Trae2api-cn 的 device_generation
// 同方案，我们的设备 id 本来就是从 uid 确定性派生的，加一代数即可）。
// 自愈闭环：claim 撞 9074 → 换一代设备立即重试一次 → 仍 9074 才记退避
// （60s × 2^min(count,3)，封顶 3600s）；成功清零；定时任务尊重退避窗口。
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-9074-'));
process.env.DUMATE_ADMIN_DATA = TMP; // 必须在 require auth 之前设

const device = require('../src/traework/device');
const authStore = require('../src/traework/auth');
const c = require('../src/traework/constants');
const checkin = require('../src/traework/checkin');

let failures = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`[${mark}] ${label}${detail ? ' — ' + detail : ''}`);
}

console.log('== deriveDevice 代数 ==');

const UID = '3675042082466132';
const g0a = device.deriveDevice(UID, 0);
const g0b = device.deriveDevice(UID);
const g1 = device.deriveDevice(UID, 1);
const g1b = device.deriveDevice(UID, 2);
check('gen 0 与不传参完全一致（既有账号设备 id 不漂移）',
  g0a.deviceId === g0b.deviceId && g0a.sessionId === g0b.sessionId && g0a.marketUserId === g0b.marketUserId);
check('gen 1 与 gen 0 不同（轮换有效）', g1.deviceId !== g0a.deviceId);
check('gen 1 与 gen 2 不同（可多代轮换）', g1b.deviceId !== g1.deviceId);
check('gen 1 仍满足格式：15 位数字 / 64 hex / UUID v4',
  /^\d{15}$/.test(g1.deviceId) && /^[0-9a-f]{64}$/.test(g1.sessionId)
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(g1.marketUserId));

console.log('== backoffMs 温和指数 ==');
check('count 0 → 60s', checkin.backoffMs(0) === 60 * 1000);
check('count 1 → 120s', checkin.backoffMs(1) === 120 * 1000);
check('count 2 → 240s', checkin.backoffMs(2) === 240 * 1000);
check('count 3 → 480s（指数封顶）', checkin.backoffMs(3) === 480 * 1000);
check('count 99 → 480s（不再涨，当天内保持尝试）', checkin.backoffMs(99) === 480 * 1000);
check('负数/垃圾输入 → 60s 下限', checkin.backoffMs(-5) === 60 * 1000 && checkin.backoffMs('x') === 60 * 1000);

console.log('== 账号准备与设备轮换 ==');

const acc = authStore.upsert({ id: 9074, uid: UID, accessToken: 'tok_' + 'x'.repeat(30), nickname: '自愈测试' });
const ensured = authStore.ensureDevice(acc);
check('ensureDevice 落盘三件套与派生源',
  ensured.deviceId && ensured.sessionId && ensured.marketUserId && ensured.deviceDerivedFrom === UID);
const dev0 = ensured.deviceId;

const rotated = authStore.rotateDevice(ensured);
check('rotateDevice 升一代且换 id', rotated && rotated.deviceGeneration === 1 && rotated.deviceId !== dev0);
check('rotateDevice 三件套同代一致（与直接派生相等）',
  rotated.deviceId === g1.deviceId && rotated.sessionId === g1.sessionId && rotated.marketUserId === g1.marketUserId);
check('rotateDevice 落盘（重读账号拿得到新 id）',
  authStore.get(9074).deviceId === rotated.deviceId);

const manual = { id: 9075, uid: 'u2', accessToken: 't' + 'y'.repeat(30), deviceId: '123456789012345', sessionId: 's', marketUserId: 'm' };
check('手填设备（无 deviceDerivedFrom）不轮换', authStore.rotateDevice(manual) === null);

console.log('== claimWithRetry 自愈闭环（打桩上游） ==');

// 桩：按端点分发。claim 按 X-Device-Id 决定结果——**只有 gen≥1 的设备能签成功**，
// 模拟「原设备被 9074 卡住、换设备即成功」的实测形态。
const seen = [];
const GOOD_DEVICE = rotated.deviceId;
c.request = async (host, ep, opts = {}) => {
  seen.push({ ep, dev: opts.headers && opts.headers['X-Device-Id'] });
  if (ep === c.EP_CHECKIN_STATUS) {
    return { status: 200, data: { data: { checked_in: false, credits: 150, enable: true } }, raw: '' };
  }
  if (ep === c.EP_CHECKIN_CLAIM) {
    if (opts.headers && opts.headers['X-Device-Id'] === GOOD_DEVICE) {
      return { status: 200, data: { code: 0, message: 'success' }, raw: '' };
    }
    return { status: 200, data: { code: 9074, message: '当前参与用户太多，请稍后再试' }, raw: '' };
  }
  if (ep === c.EP_ENT_USAGE) {
    return { status: 200, data: { data: { usage_summary: { total_amount: 5100, consumed_amount: 1690.06 } } }, raw: '' };
  }
  return { status: 404, raw: '' };
};

// 账号回到 gen 0（轮换前的原始形态）
authStore.patch(9074, { deviceGeneration: 0, deviceId: dev0, ...device.deriveDevice(UID, 0) });

(async () => {
  // 重置到 gen 0 + 清记账（用例间状态隔离）
  const resetAcc = () => {
    authStore.patch(9074, { deviceGeneration: 0, ...device.deriveDevice(UID, 0), checkin9074Count: 0, checkin9074Until: 0, lastError: '' });
    return authStore.get(9074);
  };

  const c1 = await checkin.claimWithRetry(resetAcc());
  check('9074 → 换设备重试成功，rotated 标记', c1.ok === true && c1.rotated === true, `dev=${seen.filter(s => s.ep === c.EP_CHECKIN_CLAIM).map(s => s.dev).join('→')}`);
  check('重试用的是新设备 id（老 id 只打过一次）',
    seen.filter(s => s.ep === c.EP_CHECKIN_CLAIM && s.dev === dev0).length === 1);
  check('成功后退避记账清零',
    authStore.get(9074).checkin9074Count === 0 && !authStore.get(9074).checkin9074Until);

  // 两个设备都失败 → 记退避
  c.request = async (host, ep, opts = {}) => {
    seen.push({ ep, dev: opts.headers && opts.headers['X-Device-Id'] });
    if (ep === c.EP_CHECKIN_CLAIM) return { status: 200, data: { code: 9074, message: '当前参与用户太多，请稍后再试' }, raw: '' };
    if (ep === c.EP_CHECKIN_STATUS) return { status: 200, data: { data: { checked_in: false } }, raw: '' };
    if (ep === c.EP_ENT_USAGE) return { status: 200, data: { data: { usage_summary: { total_amount: 5100, consumed_amount: 1690.06 } } }, raw: '' };
    return { status: 404, raw: '' };
  };
  const c2 = await checkin.claimWithRetry(resetAcc());
  const after2 = authStore.get(9074);
  check('两次 9074 → 退避记账 count=1', after2.checkin9074Count === 1 && after2.checkin9074Until > Date.now(), `rotated=${c2.rotated}`);
  check('lastError 带退避提示', /9074/.test(after2.lastError || '') && /重试/.test(after2.lastError || ''));

  // 退避窗口内 checkinAndSave（respectBackoff）直接跳过，不打上游
  seen.length = 0;
  const s1 = await checkin.checkinAndSave(authStore.get(9074), authStore, { respectBackoff: true });
  check('退避窗口内定时任务跳过（stage=backoff）', s1.ok === false && s1.stage === 'backoff' && s1.backoffRemaining > 0);
  check('跳过路径不打上游', seen.length === 0);
  const beforeManual = seen.length;
  const s2 = await checkin.checkinAndSave(authStore.get(9074), authStore);
  check('手动触发不拦（照打上游）', s2.stage === 'claim' && seen.length > beforeManual);

  // s2 手动触发已把 count 推到 2；显式重置后再验证 count 递增路径
  const c3 = await checkin.claimWithRetry(resetAcc());
  const after3 = authStore.get(9074);
  check('记账后 count=1、退避 ≥60s', after3.checkin9074Count === 1 && checkin.backoffRemaining(after3) >= 50 * 1000);

  // 设备轮换到「预定的可用代」后成功 → 清零
  const genNow = Number(after3.deviceGeneration) || 0;
  const GOOD_DEVICE = device.deriveDevice(UID, genNow + 1).deviceId;
  c.request = async (host, ep, opts = {}) => {
    seen.push({ ep, dev: opts.headers && opts.headers['X-Device-Id'] });
    if (ep === c.EP_CHECKIN_CLAIM) {
      return opts.headers['X-Device-Id'] === GOOD_DEVICE
        ? { status: 200, data: { code: 0, message: 'success' }, raw: '' }
        : { status: 200, data: { code: 9074, message: 'busy' }, raw: '' };
    }
    if (ep === c.EP_CHECKIN_STATUS) return { status: 200, data: { data: { checked_in: false } }, raw: '' };
    if (ep === c.EP_ENT_USAGE) return { status: 200, data: { data: { usage_summary: { total_amount: 5250, consumed_amount: 1690.06 } } }, raw: '' };
    return { status: 404, raw: '' };
  };
  const c4 = await checkin.claimWithRetry(authStore.get(9074));
  const after4 = authStore.get(9074);
  check('轮换到可用设备后签到成功', c4.ok === true && c4.rotated === true);
  check('成功后退避记账清零', after4.checkin9074Count === 0 && !after4.checkin9074Until);

  // 清理临时目录
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 留给系统清 */ }

  console.log('');
  if (failures) { console.log(`✗ ${failures} 项失败`); process.exit(1); }
  console.log('✓ 全部通过');
})();
