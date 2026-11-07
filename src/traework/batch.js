// src/traework/batch.js - 批量凭证运维的纯编排（调研 P2-14）
//
// 逐条隔离：单条失败不影响其余，响应始终带 `results:[{id, ok, error?}]`。
// 「恢复」默认**保留上游点名的冷却**（不清池状态）——上游刚说等 30 分钟就
// 立刻清掉，下一发只会再撞一次；force=true 才显式清冷却并留痕。
//
// 不做任何网络请求、不直接写账号文件：动作由 admin/routes/traework.js
// 注入，离线测试可打桩，不会因为真机 data/ 状态漂移。
const ACTIONS = ['checkin', 'probe', 'pause', 'resume', 'export'];

function normalizeIds(ids) {
  if (!Array.isArray(ids)) return { ok: false, error: 'ids 必须是数组' };
  const out = [];
  const seen = new Set();
  for (const raw of ids) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  if (!out.length) return { ok: false, error: 'ids 为空或全部无效' };
  if (out.length > 200) return { ok: false, error: '单次最多 200 个账号' };
  return { ok: true, ids: out };
}

/** 导出动作只给脱敏字段：批量接口不该成为绕过 list() 脱敏的捷径 */
function publicAccount(a) {
  if (!a) return null;
  return {
    id: a.id, uid: a.uid || '', nickname: a.nickname || '',
    region: a.region || 'cn', enabled: a.enabled !== false,
    expiresAt: a.expiresAt || null, credits: a.credits == null ? null : a.credits,
    lastCheckin: a.lastCheckin || null, deviceId: a.deviceId || '',
  };
}

/**
 * @param {object} params
 * @param {Array} params.ids
 * @param {string} params.action
 * @param {object} params.io { get, list, patch, probe, checkin, revive, now? }
 * @param {object} [params.options] { force?:boolean, enabled?:boolean }
 */
async function runBatch({ ids, action, io = {}, options = {} } = {}) {
  const check = normalizeIds(ids);
  if (!check.ok) return { ok: false, error: check.error, results: [] };
  if (!ACTIONS.includes(String(action || ''))) {
    return { ok: false, error: `action 只能是 ${ACTIONS.join(' / ')}`, results: [] };
  }
  const results = [];
  for (const id of check.ids) {
    const a = io.get ? io.get(id) : null;
    if (!a) { results.push({ id, ok: false, error: '账号不存在' }); continue; }
    try {
      if (action === 'export') {
        results.push({ id, ok: true, account: publicAccount(a) });
      } else if (action === 'pause' || action === 'resume') {
        const enabled = action === 'pause' ? false : (options.enabled === undefined ? true : !!options.enabled);
        if (!io.patch) throw new Error('账号存储不可用');
        io.patch(id, { enabled });
        // 默认保留上游冷却：只改 enabled，不碰池状态。force 是显式动作。
        if (action === 'resume' && options.force === true && io.revive) io.revive(id);
        results.push({ id, ok: true, enabled, keptCooldown: action === 'resume' && options.force !== true });
      } else if (action === 'probe') {
        if (!io.probe) throw new Error('探活模块不可用');
        const r = await io.probe(a);
        results.push({ id, ok: !!r.ok, error: r.error || '', detail: r.detail || null });
      } else if (action === 'checkin') {
        if (!io.checkin) throw new Error('签到模块不可用');
        const r = await io.checkin(a);
        results.push({ id, ok: !!r.ok, error: r.error || '', already: !!r.already, gained: r.gained ?? null });
      }
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }
  return {
    ok: true, action, total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

module.exports = { ACTIONS, normalizeIds, publicAccount, runBatch };
