// src/workbuddy/failover.js - 国内主备入口 failover 一期（P1-4，2026-11-28 融合批）
//
// 官方三入口（计划文档 P1-4）：主 www.workbuddy.cn、前门 copilot.tencent.com、
// 备 wb.tencentbuddy.com。本仓的主入口是 copilot.tencent.com（constants 的
// chatBase，全部现有流量在这上面），www.workbuddy.cn 在我们的集成里是成长/领奖
// 域——所以链序是「现役主入口在前，官方备入口在后」，语义与官方一致：主入口
// 基础设施类失败 → 换备用入口，每请求最多一次。
//
// 触发矩阵（一期，状态码阶段可判定的才触发——2xx 空响应体要读完才知道，那时
// 内容可能已经在转发，一期不覆盖）：
//   408 / 502 / 503 / 传输错误 / 超时（响应头之前）  → failover
//   504                                              → 不算（上游超时换入口没用）
//   4xx/5xx 其余（业务码）                            → 不算（走正常错误分类）
//   响应体带 retry_policy.retry === false             → 不 failover（上游明说别重试）
//
// 入口级熔断（照官方参数，不是调参对象——同 WAF 的定位）：60s 滑窗 ≥3 次基础设施
// 失败 → 该入口退避 15s，再败翻倍 30/60/120 封顶；一次成功清零。不持久化（重启
// 即清——熔断是止损不是记录）。
//
// 静态备用 IP 162.14.3.241 兜底（官方 HTTPDNS 的钉死值，二期接动态解析；一期
// 只在两个域名入口都被熔断时作为最后候选：TCP 打 IP、TLS SNI 与 Host 仍用
// 原域名——与 HTTPDNS 的语义相同，只是 IP 来源是静态）。
//
// 仅国内版。global 没有「多个入口」的实测证据，链就是单元素。
'use strict';

const INFRA_STATUS = new Set([408, 502, 503]); // 504 刻意不在——上游超时换入口没用
const WINDOW_MS = 60000;
const WINDOW_THRESHOLD = 3;
const BACKOFF_STEPS = [15000, 30000, 60000, 120000];
const STATIC_BACKUP_IP = '162.14.3.241';
const MAX_OPEN = BACKOFF_STEPS.length - 1;

// 每个入口的滑窗失败记录与退避状态（进程内，不持久化）
// state: { hits: number[], openUntil: number, strikes: number }
const entrances = new Map();

function stateOf(key) {
  let s = entrances.get(key);
  if (!s) { s = { hits: [], openUntil: 0, strikes: 0 }; entrances.set(key, s); }
  return s;
}

/** 基础设施类失败判定（状态码阶段；body 的 retry_policy 由调用方另行检查） */
function isInfraStatus(status) { return INFRA_STATUS.has(status); }

/** 传输层失败（status===0）同样算基础设施失败 */
function isTransportFailure(r) { return r && r.status === 0; }

function noteFailure(hostKey, now = Date.now()) {
  const s = stateOf(hostKey);
  s.hits = s.hits.filter((t) => t > now - WINDOW_MS);
  s.hits.push(now);
  if (s.hits.length >= WINDOW_THRESHOLD) {
    s.openUntil = now + BACKOFF_STEPS[Math.min(s.strikes, MAX_OPEN)];
    s.strikes += 1;
    s.hits = [];
  }
}

function noteSuccess(hostKey) {
  const s = stateOf(hostKey);
  s.hits = [];
  s.openUntil = 0;
  s.strikes = 0;
}

function isOpen(hostKey, now = Date.now()) {
  const s = stateOf(hostKey);
  return now < s.openUntil;
}

/** cn 域的备选入口（官方三入口里除主入口外的两个） */
const CN_BACKUP_BASES = ['https://www.workbuddy.cn', 'https://wb.tencentbuddy.com'];

/**
 * 主备候选链（breaker 感知）：主入口永远第一（熔断了也试——所有入口都熔断时
 * 请求总得发出去，宁可撞退避也不静默拒绝）；备入口按官方顺序排，跳过仍在退避
 * 中的；静态 IP 兜底只在两个域名备入口全被熔断时出现在链尾。
 *
 * @returns {Array<{base:string, hostKey:string, shadowHost?:string}>}
 *   shadowHost：静态 IP 候选的 Host/SNI 仍用原域名（HTTPDNS 语义）。
 */
function chainFor(region, chatBase) {
  const c = require('./constants');
  if (c.normalizeRegion(region) !== 'cn') return [{ base: chatBase, hostKey: chatBase }];
  const now = Date.now();
  const out = [{ base: chatBase, hostKey: chatBase }];
  const backupsOpen = [];
  let openBackups = 0;
  for (const base of CN_BACKUP_BASES) {
    if (isOpen(base, now)) { openBackups++; continue; }
    backupsOpen.push({ base, hostKey: base });
  }
  // 两个域名备入口全熔断 → 静态 IP 兜底（Host/SNI 仍是主域名）
  if (openBackups === CN_BACKUP_BASES.length) {
    const u = new URL(chatBase);
    out.push({ base: `https://${STATIC_BACKUP_IP}`, hostKey: `ip:${STATIC_BACKUP_IP}`, shadowHost: u.hostname });
  }
  return out.concat(backupsOpen);
}

/** 测试与观测用：各入口当前状态 */
function status(now = Date.now()) {
  const out = {};
  for (const [k, s] of entrances) {
    out[k] = {
      open: now < s.openUntil,
      openUntil: s.openUntil || null,
      hitsInWindow: s.hits.length,
      strikes: s.strikes,
    };
  }
  return out;
}

function _reset() { entrances.clear(); }

module.exports = {
  isInfraStatus, isTransportFailure,
  noteFailure, noteSuccess, isOpen, chainFor, status, _reset,
  INFRA_STATUS, WINDOW_MS, WINDOW_THRESHOLD, BACKOFF_STEPS, STATIC_BACKUP_IP,
};
