// src/dumate-caps.js - 搭子按模型的 max_tokens 上限（实测表 + 上游错误自学习）
//
// 旧的全局钳制 DUMATE_MAX_MAX_TOKENS=131072 来自「上游范围 [1,131072]」的实测
// ——2026-10-31 复测发现那只是 **glm-5/GLM 系一家的约束**：云网关按模型把请求
// 转发到不同上游（千帆 GLM / 千帆 DeepSeek / Kimi / 阿里百炼 Qwen），各家
// max_tokens 范围不同，且 400 错误体会原样透传上游声明：
//   text.L0 / model-text（deepseek-v4.1-flash-low-latency）→ [1, 393216]
//   glm-5（glm-5.2）      → [1, 131072]
//   text.L1（kimi-k3）    → 实测 2,000,000 仍接受（未探顶）
//   text.L2（qwen3.8-max）→ [1, 131072]
// 全局 131072 对 L0/L1 是白压低。静态表来自真机实测（按**映射后**的模型名）；
// 学习器兜上游变化：撞 400 且错误体带范围声明时把 N 记进 data/dumate-caps.json
// （7 天 TTL，原子写，仿 qoder/max-output.js），之后 clamp 用学习值——上游
// 放开或收紧都能在一次 400 之后自动跟上。学习钩子挂在 web-pool 的 400 路径
// （默认凭证来源），桌面链路的 400 会透传给客户端但不参与学习。
const fs = require('fs');
const path = require('path');

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

// 实测输出上限。没有条目的模型回落 DUMATE_MAX_MAX_TOKENS 全局值（131072）。
// mm.L1 未实测（mm.L0/L2 实测同 deepseek 后端），不进表——宁可保守。
const OUTPUT_CAPS = {
  'dm-auto-model/text.L0': 393216,
  'model-text': 393216,           // 与 text.L0 同一真实模型
  'dm-auto-model/mm.L0': 393216,  // 视觉由同一文本后端承担（2026-10-31 实测）
  'dm-auto-model/mm.L2': 393216,
  'dm-auto-model/text.L1': 2000000, // 实测下界，未探顶
  'dm-auto-model/text.L2': 131072,
  'glm-5': 131072,
};

// 上游三种范围声明（2026-10-31 各家实测）：
//   qianfan:           parameter check failed, max_tokens range is [1, 393216]
//   GLM（code 1210）:  max_tokens参数非法：限制数值范围[1,131072]
//   Aliyun:            Range of max_tokens should be [1, 131072]
const RANGE_PATTERNS = [
  /max_tokens range is \[1,\s*(\d+)\s*\]/i,
  /限制数值范围\[1,(\d+)\]/,
  /Range of max_tokens should be \[1,\s*(\d+)\s*\]/i,
];

function filePath() {
  if (process.env.DUMATE_DUMATE_CAPS_FILE) return process.env.DUMATE_DUMATE_CAPS_FILE;
  const dir = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
  return path.join(dir, 'dumate-caps.json');
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (e) { return {}; }
}

function save(data) {
  // 同步原子写：learn 只在「撞 400」这种低频错误路径上发生，防抖没有收益
  try {
    const tmp = filePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, filePath());
  } catch (e) { /* 记不上限只影响下次 clamp，不影响主流程 */ }
}

/** 从上游错误文本解析 max_tokens 上限；认不出返回 null */
function parseCap(text) {
  const s = String(text || '');
  for (const re of RANGE_PATTERNS) {
    const m = s.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/** 撞 400 时调用：从错误体学习该模型的上限（n 认不出忽略） */
function learn(model, errorText) {
  const n = parseCap(errorText);
  if (n == null) return false;
  const k = String(model || '').slice(0, 100);
  if (!k) return false;
  const data = load();
  data[k] = { n, at: Date.now() };
  save(data);
  return true;
}

/** clamp 用的上限：学习值 > 静态表 > null（调用方回落全局 DUMATE_MAX_MAX_TOKENS） */
function capOf(model, now = Date.now()) {
  const k = String(model || '').slice(0, 100);
  if (!k) return null;
  const hit = load()[k];
  if (hit) {
    const n = Number(hit.n);
    if (Number.isFinite(n) && n > 0 && Number(hit.at) && now - Number(hit.at) <= TTL_MS) return n;
  }
  return Object.prototype.hasOwnProperty.call(OUTPUT_CAPS, k) ? OUTPUT_CAPS[k] : null;
}

module.exports = { OUTPUT_CAPS, parseCap, learn, capOf, filePath, TTL_MS };
