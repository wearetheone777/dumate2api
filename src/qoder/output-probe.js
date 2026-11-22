// src/qoder/output-probe.js - 模型真实输出上限的**主动**探测（P2-20）
//
// 出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P2-20（workbuddy panel 的
// `scripts/probe_max_tokens.py`）：模型表里的 max_output_tokens 是**声称值**、
// 普遍虚高（实测 16 个模型 8 个被静默钳制，最狠声称 1M 实际 32K）。
//
// **与 `max-output.js` 的分工**（两者互补，不要合并）：
//   max-output.js  被动：撞到 400 `Range of max_tokens should be [1, N]` 才学
//                  ——第一次必然先撞一次，用户那一轮是失败的
//   output-probe.js 主动：显式运维动作，提前发现「声称 131072 实际 32K」
//                  ——不等用户撞墙
//
// 三态判定**复用 workbuddy 的口径**（`workbuddy/output-probe.judgeStep`），
// 不重写：两套判据必然漂移，而「这边说没钳制、那边说钳制了」比不测更糟。
// 唯一的差别是 Qoder 的 `finish=stop` 语义——模型自己收尾（如千问实测
// 「传 4000 输出 7808」那种主动收尾形态）只能说明「没撞顶」，记 below。
//
// **结果写数据文件，不写死在代码里**（panel 的核心纪律）：探测一次落一行，
// 重跑即刷新；30 天视为陈旧（UI 褪色标注）。
'use strict';

const fs = require('fs');
const path = require('path');

// 阶梯：与 workbuddy 一致，便于跨通道对读。Qoder 的模型表多数不带上限，
// 4 档足够覆盖「32K 级 / 131K 级」两种现实形态
const STEPS = [4096, 16384, 32768, 65536];
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
}

function filePath() {
  if (process.env.DUMATE_QODER_OUTPUT_PROBES_FILE) return process.env.DUMATE_QODER_OUTPUT_PROBES_FILE;
  return path.join(dataDir(), 'qoder-output-probes.json');
}

/** 按模型表声称的上限裁剪阶梯（声称值只作参考下界，不当真） */
function stepsFor(modelMaxTokens) {
  const cap = Number(modelMaxTokens) > 0 ? Number(modelMaxTokens) : 65536;
  const steps = STEPS.filter((s) => s <= cap);
  if (!steps.length) steps.push(STEPS[0]);
  return steps;
}

/**
 * 单档判定（纯函数）。
 *
 * **不能直接复用 workbuddy 的判据——2026-11-08 真机实测推翻**：
 * Qoder 上游**不遵守 max_tokens**。实测 `max_tokens=4096` 的那一条请求回来
 * `completion_tokens=24706`（其中 reasoning 23513）、`finish_reason=stop`。
 * 也就是说：
 *   1. `finish=length` 几乎不会出现（它按自己的节奏收尾），workbuddy 那套
 *      「finish=length 且明显不足 → clamped」在 Qoder 上**永远测不出东西**；
 *   2. `completion > requested` 本身就是强证据——**它根本没被我们的值约束**。
 *
 * 所以判据按 Qoder 的真实形态重写三条：
 *   exceeded     completion > requested × 1.05 → 上游不理 max_tokens
 *                （verdict 记为 `unbounded`：**没有可测的上限**，这本身就是结论）
 *   clamped      finish=length 且 completion 明显不足 requested（撞了别的顶；
 *                本形态在真机还没出现过，保留以防上游行为变化）
 *   at_least     finish=length 且追平 requested（真实上限 ≥ 该档）
 *   below        finish=stop 且 completion ≤ requested（模型自己收尾，没撞顶）
 *   inconclusive 无 usage / 其它 finish
 *
 * @returns {'exceeded'|'clamped'|'at_least'|'below'|'inconclusive'}
 */
function judgeStep(requested, completion, finish) {
  if (!Number.isFinite(completion) || completion <= 0) return 'inconclusive';
  const req = Number(requested);
  if (!(req > 0)) return 'inconclusive';
  // **超发**先判：completion 超过请求值说明它压根没看 max_tokens
  if (completion > req * 1.05) return 'exceeded';
  if (finish === 'length') {
    return completion >= req * 0.9 ? 'at_least' : 'clamped';
  }
  if (finish === 'stop') return 'below';
  return 'inconclusive';
}

/** 探针用的长输出请求。**明确要求长文**：短回答全是 stop，测不出任何东西 */
function probePrompt(n) {
  return `请围绕「长期坚持写日记的好处」这个主题写一篇尽可能长的说明文。`
    + `要求：不要分点、不要小标题，用连贯段落；写满约 ${Math.round(n / 2)} 字再停。`;
}

/**
 * 探一个模型。
 *
 * @param {string} model 模型 key（不含 `qoder/` 前缀，如 `gfmodel`）
 * @param {object} [opts]
 *   opts.region  'cn' | 'global'
 *   opts.send    注入的发送函数（默认走 qoder/index.send，测试可打桩）
 *   opts.modelMaxTokens 声称上限（裁阶梯；取不到按 65536）
 * @returns {object} 探测行
 */
async function probeOne(model, opts = {}) {
  const region = opts.region === 'global' || opts.region === 'intl' ? 'global' : 'cn';
  const startedAt = Date.now();
  const steps = stepsFor(opts.modelMaxTokens);

  let send = opts.send;
  if (!send) {
    const index = require('./index');
    send = async (payload) => index.chatCompletion(payload, { region, probe: true });
  }

  const stepRows = [];
  let verdict = 'inconclusive';
  let atLeast = null;
  let clamped = null;
  let unbounded = null;
  let error = '';

  for (const n of steps) {
    let completion = null;
    let finish = null;
    let err = '';
    let learned = null;
    try {
      const agg = await send({
        model: `qoder/${model}`,
        messages: [{ role: 'user', content: probePrompt(n) }],
        max_tokens: n,
      });
      const u = (agg && agg.usage) || null;
      completion = u ? (u.completion_tokens || 0) : null;
      finish = (agg && agg.choices && agg.choices[0] && agg.choices[0].finish_reason) || null;
    } catch (e) {
      err = e.message || String(e);
      // **上游 400 的显式范围声明**是最权威的答案（`Range of max_tokens
      // should be [1, N]`）。撞上它不是「失败」，而是直接问到了真值——
      // 这正是 max-output.js 的被动学习路径，这里顺手接上，省一次探测。
      const m = /Range of max_tokens should be \[1,\s*(\d+)\]/i.exec(err);
      if (m) {
        learned = Number(m[1]);
        clamped = learned;
        verdict = 'clamped';
        stepRows.push({ requested: n, completion: null, finish: null, verdict: 'declared', declared: learned, error: err.slice(0, 200) });
        try { require('./max-output').learn(region, model, learned); } catch (e2) { /* 记不上限不影响探测结论 */ }
        break;
      }
    }
    const j = err ? 'inconclusive' : judgeStep(n, completion, finish);
    stepRows.push({ requested: n, completion, finish, verdict: j, error: err ? err.slice(0, 200) : undefined });
    if (j === 'exceeded') {
      // **上游不理 max_tokens**：第一档就够了——它没被我们的值约束，
      // 再往上探也是同一个结论，只会白烧几分钟与一笔额度。
      unbounded = { requested: n, completion };
      verdict = 'unbounded';
      break;
    }
    if (j === 'clamped' && clamped == null) {
      clamped = completion;
      verdict = 'clamped';
      // 已撞顶：更高档只会得到同样的钳制，不必再烧额度
      break;
    }
    if (j === 'at_least') {
      atLeast = n;
      verdict = 'at_least';
      continue; // 追平了 → 升阶确认真实上限
    }
    if (j === 'below') {
      // 自然收尾（stop）：真实上限 ≥ 本档但探索不出更多，记 at_least 本轮档位
      atLeast = Math.max(atLeast || 0, n);
      verdict = 'at_least';
    }
    // inconclusive：单档失败可能是限流，换一档可能就成
  }

  const row = {
    model,
    region,
    verdict,
    atLeast,
    clamped,
    // unbounded 的证据（上游不理 max_tokens 时的请求值与回吐量）
    unbounded,
    modelMaxTokens: Number.isFinite(Number(opts.modelMaxTokens)) && Number(opts.modelMaxTokens) > 0
      ? Number(opts.modelMaxTokens) : null,
    steps: stepRows,
    ts: Date.now(),
    elapsedMs: Date.now() - startedAt,
  };
  if (error) row.error = error;
  return row;
}

/** 读全量探测结果（键 model|region）。文件缺失/坏 → 空表 */
function loadProbes() {
  try {
    const doc = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return doc && typeof doc === 'object' ? doc : {};
  } catch (e) { return {}; }
}

/** 原子落盘探测行。写失败不影响返回（探针结果丢了可以重跑） */
function saveProbe(row) {
  try {
    const filelock = require('../filelock');
    fs.mkdirSync(dataDir(), { recursive: true });
    const doc = loadProbes();
    doc[`${row.model}|${row.region}`] = row;
    const target = filePath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    filelock.renameAtomic(tmp, target);
    return true;
  } catch (e) { return false; }
}

/** 探测结果是否过期（UI 褪色标注用）：30 天。panel 同款阈值 */
function isStale(row, now = Date.now()) {
  return !row || !row.ts || (now - row.ts > STALE_MS);
}

/**
 * 给模型表叠加探测结论（供管理端与 `model-info` 显示）。
 *
 * 标注口径（与 panel 一致）：
 *   clamped     → `32K ⚠ 钳制 12×`（声称 vs 实测的倍数）
 *   at_least    → `48K ✓`（追平过该档）
 *   inconclusive→ `?`（测不出，不猜）
 *   **无记录**   → 不标注（没测过 ≠ 没钳制）
 *
 * @param {Array} models 模型表行（带 key/name、可选 maxTokens）
 * @param {object} [opts] { region, now, probes }
 * @returns {Array} 新数组，每行多一个 `probe` 字段（无记录时为 null）
 */
function decorate(models, opts = {}) {
  const region = opts.region === 'global' || opts.region === 'intl' ? 'global' : 'cn';
  const now = Number(opts.now) || Date.now();
  const doc = opts.probes || loadProbes();
  return (models || []).map((m) => {
    const key = String((m && (m.key || m.name)) || '');
    const hit = doc[`${key}|${region}`] || null;
    if (!hit) return { ...m, probe: null };
    const claimed = Number(hit.modelMaxTokens) || null;
    const actual = hit.verdict === 'clamped' ? hit.clamped : (hit.verdict === 'at_least' ? hit.atLeast : null);
    // 钳制倍数：声称 131072 / 实测 32768 ≈ 4×。只在两者都有时给
    const ratio = (hit.verdict === 'clamped' && claimed && actual) ? Math.round((claimed / actual) * 10) / 10 : null;
    let label = '?';
    if (hit.verdict === 'unbounded') {
      // **上游不理 max_tokens**：这不是「上限很大」，是「没有可测的上限」。
      // 标注要给证据（传了多少、回来多少），否则读者会当成测错了。
      label = `${fmtK(hit.unbounded && hit.unbounded.completion)} ۞ 不受 max_tokens（传 ${fmtK(hit.unbounded && hit.unbounded.requested)}）`;
    } else if (hit.verdict === 'clamped' && actual) {
      label = `${fmtK(actual)} ⚠ 钳制${ratio && ratio > 1 ? ` ${ratio}×` : ''}`;
    } else if (hit.verdict === 'at_least' && actual) {
      label = `${fmtK(actual)} ✓`;
    }
    return {
      ...m,
      probe: {
        verdict: hit.verdict,
        label,
        actual: hit.verdict === 'unbounded'
          ? (hit.unbounded && hit.unbounded.completion) || null
          : actual,
        claimed,
        ratio,
        unbounded: hit.unbounded || null,
        ts: hit.ts,
        stale: isStale(hit, now),
      },
    };
  });
}

/**
 * 千级缩写。**按 1024 而不是 1000**：32768 读作 32K、65536 读作 64K——
 * 这是这个领域所有人（含 workbuddy panel 的标注 `32K ⚠ 钳制 12×`）的读法。
 * 按 1000 算会得到 33K/66K，与上下游文档里的数字对不上，反而增加认知成本。
 */
function fmtK(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '?';
  if (v >= 1024) return `${Math.round(v / 1024)}K`;
  return String(v);
}

/**
 * 探测任务编排（**触发式**，不做成同步 HTTP）。
 *
 * **2026-11-08 真机实测决定**：单档 `max_tokens=4096` 要 **214 秒**
 * （completion 24706 / reasoning 23513）。四档串行就是十几分钟——同步 HTTP
 * 必然超时，浏览器也会先断。所以与 `/autocheckin/run` 同款交付形态：
 * 触发后立刻返回，结果靠 GET 轮询。
 *
 * 状态**进程内即弃**：探测是显式运维动作，进程重启后重跑一次即可（结果本身
 * 已落盘，重跑只是刷新）。不做跨进程共享——两个进程各排一份会把额度翻倍。
 */
const jobs = {
  running: false,
  startedAt: null,
  model: '',
  region: '',
  finishedAt: null,
  last: null,
};

/** 当前是否有探测在跑（前端按钮的 loading 与排他判据） */
function status() {
  return {
    running: jobs.running,
    model: jobs.model,
    region: jobs.region,
    startedAt: jobs.startedAt,
    finishedAt: jobs.finishedAt,
    elapsedMs: jobs.startedAt ? (jobs.finishedAt || Date.now()) - jobs.startedAt : 0,
    last: jobs.last,
  };
}

/**
 * 起一次探测（异步，立刻返回）。同一时刻只允许一个——探测是重额度动作，
 * 并发跑等于把「最省的 0.1 档」变成四倍消耗。
 *
 * @returns {{started:boolean, reason?:string}}
 */
function start(model, opts = {}) {
  if (jobs.running) return { started: false, reason: '已在探测中' };
  const region = opts.region === 'global' || opts.region === 'intl' ? 'global' : 'cn';
  jobs.running = true;
  jobs.startedAt = Date.now();
  jobs.finishedAt = null;
  jobs.model = model;
  jobs.region = region;
  jobs.last = null;
  // 不 await：调用方（HTTP handler）要立刻返回
  (async () => {
    try {
      const row = await probeOne(model, { ...opts, region });
      saveProbe(row);
      jobs.last = row;
    } catch (e) {
      jobs.last = { model, region, verdict: 'inconclusive', error: e.message, ts: Date.now() };
    } finally {
      jobs.running = false;
      jobs.finishedAt = Date.now();
    }
  })();
  return { started: true };
}

module.exports = {
  STEPS, STALE_MS,
  stepsFor, judgeStep, probePrompt, probeOne,
  loadProbes, saveProbe, isStale, decorate, fmtK, filePath,
  // 触发式编排
  start, status,
};
