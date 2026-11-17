// src/throttle.js - 通道风控参数的**唯一解析点**（面板 > 环境变量 > 内置默认）
//
// 调研 P1-9「账号级风控参数上台」：并发/间隔/短故障重试原来只认环境变量，
// 改一次要重开三个进程。现在这三个旋钮同时可被管理端热改（落 livecfg），
// 但**优先级必须只有一份实现**——否则 channel-pool 按一套读、repair 按另一套
// 读，界面显示「3」而实际生效「1」，正是本项目反复踩的那类静默故障。
//
// 三个旋钮的语义**刻意不同**，照抄会错：
//
// | 旋钮           | 面板 null | 面板 0        | env 缺省 | 兜底            |
// |----------------|-----------|---------------|----------|-----------------|
// | inflightMax    | 未设      | 等同未设      | 未设     | 池默认 4        |
// | minIntervalMs  | 未设      | **显式关断**  | 未设     | 0（关）         |
// | retryMax       | 未设      | **显式关断**  | 未设     | 共享默认 1      |
//
// `inflightMax` 的 0 为什么等于未设：0 个在途名额是死锁，没有「关掉并发」这种
// 合理需求，所以 0 只能表示「没填」。另两个 0 是真实意图（不许隔、不许重试），
// 必须能穿透 env —— 否则 env 一旦设了值，界面上就再也关不掉了。
//
// 第四个旋钮 `throttleMaxMs`（排队限流冷却上限）是**全局**的，不按通道分：
// 封顶发生在 upstream-errors 的 classifyType 里，那里不知道通道是谁。硬按
// 通道分会产生「以为按 Qoder 调了，实际作用于全部通道」的假象。
//
// 一致性纪律：`src/channel-pool.js`、`src/repair.js`、`src/upstream-errors.js`
// 三处消费方**都经本模块取值**，不得再各自读 process.env。
const livecfg = require('./livecfg');

/** 有 channel-pool 接线的直连通道（dumate 走 web-pool，不在此列） */
const CHANNELS = ['qwenwork', 'traework', 'qoder', 'workbuddy'];

/** 按通道配置的三个旋钮 */
const KNOBS = ['inflightMax', 'minIntervalMs', 'retryMax'];

/** 旋钮 → 环境变量名（<CH> 为通道 id 大写） */
function envNameOf(knob, channel) {
  const CH = String(channel || '').toUpperCase();
  if (knob === 'inflightMax') return `DUMATE_${CH}_INFLIGHT_MAX`;
  if (knob === 'minIntervalMs') return `DUMATE_${CH}_MIN_INTERVAL_MS`;
  if (knob === 'retryMax') return `DUMATE_${CH}_REPAIR_RETRY`;
  return '';
}

/** 环境变量里的非负整数（缺省/非法 → null，不是 0——0 是有效值） */
function envNum(name) {
  if (!name) return null;
  const raw = process.env[name];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function isChan(channel) {
  return CHANNELS.includes(String(channel || ''));
}

/** 面板里该通道该旋钮的原始值（null = 未设） */
function panelOf(channel, knob) {
  let table;
  try { table = livecfg.Load().throttle || {}; } catch (e) { return null; }
  const row = table[String(channel || '')];
  if (!row || typeof row !== 'object') return null;
  const v = row[knob];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * 解析一个旋钮。
 *
 * @returns {{value:number|null, source:'panel'|'env'|'default', panel:number|null,
 *            envValue:number|null, env:string}}
 *   value=null 表示「本模块不提供兜底」，由消费方用它自己的默认值
 *   （channel-pool 用池默认 4、repair 用共享默认 1）。
 */
function resolve(channel, knob) {
  const env = envNameOf(knob, channel);
  const panel = panelOf(channel, knob);
  const envValue = envNum(env);
  const zeroIsMeaningful = knob !== 'inflightMax';
  if (panel != null && (panel > 0 || zeroIsMeaningful)) {
    // 面板 > 0 一律生效；面板 0 只在「0 有意义」的旋钮上生效（显式关断）
    return { value: panel, source: 'panel', panel, envValue, env };
  }
  if (envValue != null) return { value: envValue, source: 'env', panel, envValue, env };
  return { value: null, source: 'default', panel, envValue, env };
}

/** 只要值（消费方用）。null = 交回调用方默认 */
function knob(channel, knobName) {
  return resolve(channel, knobName).value;
}

/** 该通道三个旋钮的完整解析结果（管理端展示「为什么是现在这个值」用） */
function channelRow(channel) {
  const knobs = {};
  for (const k of KNOBS) knobs[k] = resolve(channel, k);
  return { channel, knobs };
}

/** 全部通道的解析结果 */
function all() {
  return CHANNELS.map(channelRow);
}

/**
 * 排队限流冷却上限（ms）。**全局单值**，热读：面板 > env > 600000。
 *
 * 下限 1000 与 `upstream-errors` 原来的 `Math.max(1000, …)` 同口径——0 或负数
 * 会把冷却压成 0，等于关掉封顶，那会让上游给的 7015 秒照单全收。
 */
function throttleMaxMs() {
  let panel = 0;
  try { panel = Number(livecfg.Load().throttleMaxMs) || 0; } catch (e) { panel = 0; }
  const envValue = envNum('DUMATE_THROTTLE_MAX_MS');
  const source = panel > 0 ? 'panel' : (envValue != null ? 'env' : 'default');
  const raw = panel > 0 ? panel : (envValue != null ? envValue : 600000);
  return { value: Math.max(1000, raw), source, panel, envValue };
}

module.exports = {
  CHANNELS, KNOBS, envNameOf, envNum, resolve, knob, channelRow, all, throttleMaxMs,
};
