// src/qwenwork/model-overrides.js - 千问逐模型开关与能力覆盖层（2026-11-27 融合 A1）
//
// 见 docs/PLAN-QWENWORK-GITHUB-MERGE-ROUND2.md §A1。社区实现
// （ponm3ay/dsh-connect-qwenwork 的 DETAIL.md）：每模型总开关 + 三项能力覆盖层
// （上下文 / 图片 / 思考强度），没动过跟随目录、动过标「已改」+「跟随目录」撤回。
//
// 纪律（改之前先读）：
//   - 覆盖层是**本机偏好**，不是会话状态：刷新目录不重置，目录删模型清开关。
//   - 落盘原子写（.tmp + rename），mtime 热读——与 modelmap.js / keys.js 同款，
//     改完立即生效，不需要重启网关。
//   - 禁用模型在 send() 发出前拦截（403，不扣积分），/v1/models 过滤。
//   - 数据目录跟随 DUMATE_ADMIN_DATA（管理端与网关必须一致，否则两边读到不同覆盖）。
const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'data');

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || DEFAULT_DIR;
}

function file() {
  return process.env.DUMATE_QWENWORK_OVERRIDES_FILE
    || path.join(dataDir(), 'qwenwork-model-overrides.json');
}

function empty() {
  return { disabled: [], overrides: {} };
}

function load() {
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return empty();
    return {
      disabled: Array.isArray(j.disabled) ? j.disabled.map(String) : [],
      overrides: (j.overrides && typeof j.overrides === 'object') ? j.overrides : {},
    };
  } catch (e) {
    // 文件不存在或半 JSON：按空覆盖处理，不阻断（首次启动即此态）
    return empty();
  }
}

/** 原子写：先写 .tmp 再 rename（与 store.js 同款，防 kill 留下半 JSON） */
function save(state) {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, f);
}

// ---- 查询 ----

/** 禁用集合（去重、字符串） */
function disabledSet() {
  return new Set(load().disabled);
}

/** 是否被禁用（按解析后的模型 key 判，别名也拦得住） */
function isDisabled(modelKey) {
  return disabledSet().has(String(modelKey));
}

/** 取某模型的覆盖（无覆盖返回 null） */
function overrideOf(modelKey) {
  const ov = load().overrides[String(modelKey)];
  return ov && typeof ov === 'object' ? ov : null;
}

/**
 * 合并目录默认 + 覆盖：返回带覆盖字段与最终值的完整视图（供管理端展示）。
 * - contextOverride / visionOverride / reasoningOverride：null = 跟随目录
 * - effective*：合并后的最终值（前端直接用）
 * - dirty：是否动过覆盖（前端标「已改」+ 给「跟随目录」按钮）
 */
function mergedView(entries) {
  const st = load();
  return entries.map((e) => {
    const ov = st.overrides[e.key] || {};
    const dirty = Object.keys(ov).length > 0;
    return {
      ...e,
      disabled: st.disabled.includes(e.key),
      contextOverride: ov.context != null ? ov.context : null,
      visionOverride: ov.vision != null ? ov.vision : null,
      reasoningOverride: ov.reasoning != null ? ov.reasoning : null,
      effectiveContext: ov.context != null ? ov.context : e.contextWindow,
      effectiveVision: ov.vision != null ? ov.vision : e.multimodal,
      effectiveReasoning: ov.reasoning != null ? ov.reasoning : e.reasoning,
      dirty,
    };
  });
}

// ---- 写入 ----

/** 切换禁用（开/关） */
function setDisabled(modelKey, disabled) {
  const st = load();
  const k = String(modelKey);
  const set = new Set(st.disabled);
  if (disabled) set.add(k); else set.delete(k);
  st.disabled = [...set];
  save(st);
  return st;
}

/** 写单项能力覆盖。field ∈ context / vision / reasoning */
function setOverride(modelKey, field, value) {
  if (!['context', 'vision', 'reasoning'].includes(field)) {
    throw new Error(`非法覆盖字段: ${field}`);
  }
  const st = load();
  const k = String(modelKey);
  if (!st.overrides[k]) st.overrides[k] = {};
  st.overrides[k][field] = value;
  save(st);
  return st;
}

/** 跟随目录：清该模型全部覆盖 */
function clearOverride(modelKey) {
  const st = load();
  delete st.overrides[String(modelKey)];
  save(st);
  return st;
}

/**
 * 目录刷新后清理：目录里没有的模型，禁用与覆盖都清掉（不残留）。
 * 返回是否发生变化——没变不写盘（避免每次刷新都触发一次写）。
 */
function prune(knownKeys) {
  const st = load();
  const set = new Set(knownKeys.map(String));
  const beforeDisabled = st.disabled.length;
  const beforeOverrides = Object.keys(st.overrides).length;
  st.disabled = st.disabled.filter((k) => set.has(k));
  for (const k of Object.keys(st.overrides)) {
    if (!set.has(k)) delete st.overrides[k];
  }
  const changed = st.disabled.length !== beforeDisabled
    || Object.keys(st.overrides).length !== beforeOverrides;
  if (changed) save(st);
  return { changed, state: st };
}

module.exports = {
  load, save,
  disabledSet, isDisabled, overrideOf, mergedView,
  setDisabled, setOverride, clearOverride, prune,
  file,
};
