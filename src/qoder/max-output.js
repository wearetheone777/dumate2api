// src/qoder/max-output.js - max_tokens 上游上限的自学习（对齐 qoder2api-hub #101）
//
// 上游模型表不带 maxOutputTokens，客户端超限时上游回 400：
//   Range of max_tokens should be [1, N]
// 第一次撞上限如实报错（网关靠它才知道 N），同时把 N 记下来；之后
// chat.buildBody 出站前自动 clamp，同一模型不再踩第二次。
//
// 记录按 (区域, 模型) 一条，7 天 TTL——上游放开上限后旧值要能自然失效。
// 落盘 data/qoder-max-output.json（原子写：先 .tmp 再 rename）。
const fs = require('fs');
const path = require('path');

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function filePath() {
  if (process.env.DUMATE_QODER_MAX_OUTPUT_FILE) return process.env.DUMATE_QODER_MAX_OUTPUT_FILE;
  const dir = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
  return path.join(dir, 'qoder-max-output.json');
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (e) { return {}; }
}

function save(data) {
  // 同步原子写。learn 只在「撞 max_tokens 上限的 400」这种低频错误路径上发生，
  // 防抖没有收益反而把落盘变成异步——测试与排障都要多等一步。
  try {
    const tmp = filePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, filePath());
  } catch (e) { /* 记不上限只影响下次 clamp，不影响主流程 */ }
}

/** 记录一次学习到的上限（n 非法或 <=0 忽略） */
function learn(region, modelKey, n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return false;
  const r = String(region || 'global');
  const k = String(modelKey || '').slice(0, 100);
  if (!k) return false;
  const data = load();
  data[`${r}:${k}`] = { n: v, at: Date.now() };
  save(data);
  return true;
}

/** 取该模型的上限；没有记录或已过 TTL（7 天）返回 null */
function get(region, modelKey, now = Date.now()) {
  const r = String(region || 'global');
  const k = String(modelKey || '').slice(0, 100);
  const hit = load()[`${r}:${k}`];
  if (!hit) return null;
  const n = Number(hit.n);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!Number(hit.at) || now - Number(hit.at) > TTL_MS) return null;
  return n;
}

module.exports = { learn, get, filePath, TTL_MS };
