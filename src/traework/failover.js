// src/traework/failover.js - 跨区容灾的判定（纯函数，2026-11-16 调研 P0-3 子项）
//
// 只回答一个问题：**这次请求该不该改派到对方区**。执行（递归重发）留在
// index.js，因为那边才知道 onChunk / 埋点 / 账号池的上下文。
//
// ## 为什么要有这么严的前置
//
// 「跨区容灾」和「一遇错误就换区域」是两件事，后者很危险：
//   · 限流（429）换区域 = 用另一个区的账号绕过本地限流，只是把压力搬到别处，
//     而且会让「本区账号都在冷却」这个事实在日志里看不出来；
//   · 参数错误换区域 = 白打一次上游，把明确的 400 拖成慢失败；
//   · API Key 绑了区域还换 = 绕过鉴权约束（本项目 `keys.region` 是硬约束）。
// 所以只在本区**确实一个可用账号都没有**（不是「都冷却了」也是，那同样算没有
// 可用账号）且对方区**真有账号 + 模型在那边已知**时才动。默认关。
//
// 与 `degrade.js` 的分工：那个管「换模型/换区以续命额度」，只认确证的额度/
// 升级错误；这个管「本区没人接活时换到另一区的人」。两者都默认关、都留痕迹。

/**
 * @param {object} p
 * @param {object} p.cfg         trae-runtime 的 crossRegionFailover（{enabled,to}）
 * @param {string} p.poolRegion  当前被钉死的区域（'' = 未钉）
 * @param {string} p.curRegion   现在这一区（'cn' | 'intl'）
 * @param {string} p.model       调用方请求的模型名（已剥前缀）
 * @param {boolean} p.tried      本次请求是否已经试过跨区（防来回弹）
 * @param {function} p.hasAccount (region) => 该区有没有可用账号
 * @param {function} p.known      (model, region) => 该模型在该区模型表里是否已知
 * @returns {{from:string, to:string}|null}
 */
function plan(p) {
  const o = p || {};
  const cfg = o.cfg || {};
  if (cfg.enabled !== true) return null;
  if (o.tried === true) return null;               // 只试一次
  if (o.poolRegion) return null;                   // Key 或模型亲和要求钉死了区域
  const model = String(o.model || '').trim();
  if (!model) return null;                         // auto 档不跨区：对方区认不认这个"auto"没有依据
  const cur = o.curRegion === 'intl' ? 'intl' : 'cn';
  const want = cfg.to === 'cn' || cfg.to === 'intl' ? cfg.to : (cur === 'cn' ? 'intl' : 'cn');
  if (want === cur) return null;
  if (typeof o.hasAccount === 'function' && !o.hasAccount(want)) return null;
  if (typeof o.known === 'function' && !o.known(model, want)) return null;
  return { from: cur, to: want };
}

module.exports = { plan };
