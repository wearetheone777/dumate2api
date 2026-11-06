// src/workbuddy/rate-ledger.js - 实测单价台账（M2.6，panel costTier 思想）
//
// 出处：workbuddy2api-panel 的 NoteModelCost——每个模型记一份**实测倍率的
// EMA**（credits ÷ 千 token），与模型表标称并排展示，倍率元数据过期或上游
// 改计费口径时当场暴露。
//
// 为什么只由 billing-check 探针喂：WorkBuddy 当前公测口径 usage.credit=0
//（对话不实时扣套餐，2026-11-04 探针实测），真实流量没有可信的计量字段——
// 把 usage.credit 落进台账只会污染样本。探针的 delta 是前后快照差值的干净
// 测量，是当前唯一有效样本源。
//
// EMA 而非均值：上游改口径后旧样本要能「淡忘」，EMA(alpha=0.3) 让最近 5~10
// 次探测主导读数；min/max 留全距供人工判读。原子落盘，管理端与网关两进程
// 都可能写（filelock 保护）。
const fs = require('fs');
const path = require('path');

const ALPHA = 0.3;

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
}
function filePath() {
  return path.join(dataDir(), 'workbuddy-rate-ledger.json');
}

/** 读全量台账（键 model|region）。文件缺失/坏 → 空表 */
function loadLedger() {
  try {
    const doc = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return doc && typeof doc === 'object' ? doc : {};
  } catch (e) {
    return {};
  }
}

function saveLedger(doc) {
  const filelock = require('../filelock');
  const target = filePath();
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  filelock.renameAtomic(tmp, target);
}

/** 区域归一：intl 是对外术语，落盘统一用 global（与通道内部一致） */
function normRegion(region) {
  return region === 'global' || region === 'intl' ? 'global' : 'cn';
}

/**
 * 记一次实测倍率（credits ÷ (tokens/1000)，来自 billing-check 的 delta 口径）。
 * EMA 更新：ema = alpha*sample + (1-alpha)*ema；首样本直接落。
 * 返回更新后的行（null = 入参无效，不记脏样本）。
 */
function recordRate(model, region, billed, opts = {}) {
  const m = String(model || '').trim().replace(/^workbuddy\//, '');
  const r = normRegion(region);
  const x = Number(billed);
  if (!m || !Number.isFinite(x) || x < 0) return null;
  const filelock = require('../filelock');
  return filelock.withLock(filePath(), () => {
    const doc = loadLedger();
    const key = `${m}|${r}`;
    const prev = doc[key];
    const ema = prev && Number.isFinite(prev.ema) ? ALPHA * x + (1 - ALPHA) * prev.ema : x;
    const row = {
      model: m,
      region: r,
      ema: Math.round(ema * 10000) / 10000,
      samples: (prev ? prev.samples || 0 : 0) + 1,
      last: Math.round(x * 10000) / 10000,
      min: prev && Number.isFinite(prev.min) ? Math.min(prev.min, x) : x,
      max: prev && Number.isFinite(prev.max) ? Math.max(prev.max, x) : x,
      ts: Date.now(),
    };
    if (opts.nominal != null) row.nominal = Number(opts.nominal);
    doc[key] = row;
    saveLedger(doc);
    return row;
  });
}

/** 读一行（model|region）；无样本返回 null */
function getRate(model, region) {
  const m = String(model || '').trim().replace(/^workbuddy\//, '');
  const r = normRegion(region);
  if (!m) return null;
  return loadLedger()[`${m}|${r}`] || null;
}

module.exports = { ALPHA, loadLedger, recordRate, getRate, filePath };
