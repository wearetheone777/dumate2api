// src/admin/routes/qoder-runtime.js - Qoder 运行期配置 + 自动签到排程端点
//
// 出处：docs/QODER-GATEWAY-FEATURE-MERGE.md
//   P0-3 运行时配置面板化（热生效）
//   P0-1 签到自动排程
//   P1-11 /health 风控遥测（本文件只暴露数据面，聚合在 src/server.js）
//
// 分工：配置本体在 `src/qoder/runtime.js`（跨进程按 mtime 热读），排程本体在
// `src/qoder/autocheckin.js`（管理端进程内定时器）。这里只做三件事：
//   1. 字段级校验与审计（未知键在 Store 里 400，不静默丢弃）
//   2. 把「面板值 / env 默认值 / 当前生效值」并排给出——三者不一致时界面要能
//      看见（例如 env 钉了 60000，面板写了 120000，生效的是哪一个）
//   3. 需重启字段清单（本项目目前为空：全部热生效，如实报空而不是编一个）
const { sendJSON } = require('../router');
const runtime = require('../../qoder/runtime');
const chat = require('../../qoder/chat');

/** env 默认值（面板没配时的来源）：每次现读，与 runtime.defaults 同一口径 */
function envDefaults() {
  return runtime.defaults();
}

/**
 * 当前**真正生效**的值。
 *
 * 与 Load() 的区别：Load() 给的是配置快照，而生效值可能还要经过「调用方自己的
 * 兜底」（例如 chat.js 的 firstByteMs() 在读到非法值时会回落到字面默认）。
 * 界面显示配置快照就行，但**验证面板真的生效**要看这一组。
 */
function effective() {
  let cp = null;
  try { cp = require('../../channel-pool'); } catch (e) { cp = null; }
  return {
    timeouts: {
      firstByteMs: chat.firstByteMs(),
      contentMs: chat.contentMs(),
      readIdleMs: chat.readIdleMs(),
      maxBodyMb: chat.maxBodyMb(),
    },
    // 闸门参数的实际生效值（含 env 兜底与池默认）。0 的语义见 note。
    concurrency: cp ? {
      inflightMax: cp.inflightMaxOf('qoder'),
      minIntervalMs: cp.minIntervalMsOf('qoder'),
      pickStrategy: cp.pickStrategyOf('qoder'),
    } : null,
  };
}

/**
 * 配置的「需重启」清单。**本项目全部热生效**——空数组是如实结论，不是占位。
 * 保留这个字段是为了让前端有一个稳定的形状（将来真出现装配期字段时不必改协议）。
 */
const RESTART_FIELDS = [];

/** 排程状态的轻量快照（排程模块加载失败时也要能回一个可读的响应） */
function autoCheckinSnapshot() {
  try {
    return { ok: true, ...require('../../qoder/autocheckin').snapshot() };
  } catch (e) {
    return { ok: false, error: `自动签到排程不可用：${e.message}` };
  }
}

const routes = [
  {
    // 当前配置 + env 默认 + 需重启清单
    method: 'GET',
    path: '',
    handler: async ({ res }) => {
      return sendJSON(res, 200, {
        file: runtime.FILE,
        fields: runtime.FIELDS,
        subfields: runtime.SUBFIELDS,
        config: runtime.Load(),
        envDefaults: envDefaults(),
        effective: effective(),
        restartFields: RESTART_FIELDS,
        note: '全部字段热生效：保存后网关下一次请求判定就读到新值，不需要重启。'
          + 'env 仍是默认值来源——只设环境变量不碰面板的部署行为不变。'
          + '0 的语义逐项不同：首字节/无内容/读空闲 = 关闭计时器，'
          + 'pollBudgetMs = 不等待，pollIntervalMs = 按上游 retryAfter，fefoDays = 关闭 FEFO，'
          + 'repair.retry = 关闭修复，concurrency.inflightMax = 用池默认 4，'
          + 'concurrency.minIntervalMs = 关闭最小间隔，concurrency.pickStrategy 空串 = 池默认加权抽签。',
      });
    },
  },
  {
    method: 'PUT',
    path: '',
    handler: async ({ res, body, user }) => {
      try {
        const out = runtime.Store(body || {});
        try {
          require('../auth').audit(user && user.username, 'qoder_runtime_config', '',
            JSON.stringify(out.changed));
        } catch (e) { /* 审计失败不影响生效 */ }
        return sendJSON(res, 200, {
          ok: true,
          config: out.config,
          changed: out.changed,
          effective: effective(),
          restartFields: RESTART_FIELDS.filter((f) => JSON.stringify(out.changed).includes(f)),
        });
      } catch (e) {
        // 未知键 / 越界值一律 400：把「以为设了阈值」静默吞成默认值是最糟的失败
        return sendJSON(res, 400, { ok: false, error: e.message });
      }
    },
  },
  {
    // 一键回落到 env 默认值（删掉面板文件即可，不重写字段）
    method: 'DELETE',
    path: '',
    handler: async ({ res, user }) => {
      try {
        const fsp = require('fs');
        const p = runtime.filePath();
        let removed = false;
        try { fsp.unlinkSync(p); removed = true; } catch (e) { removed = false; }
        runtime._resetForTest();
        try {
          require('../auth').audit(user && user.username, 'qoder_runtime_reset', p, removed ? 'deleted' : 'absent');
        } catch (e) { /* 忽略 */ }
        return sendJSON(res, 200, {
          ok: true, removed, config: runtime.Load(), effective: effective(),
          note: '已删除面板配置，全部字段回落到 env 默认值。',
        });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    },
  },
  {
    // 自动签到排程：开关 / 时点 / 抖动 / 上次结果 / 下次触发
    method: 'GET',
    path: '/autocheckin',
    handler: async ({ res }) => sendJSON(res, 200, autoCheckinSnapshot()),
  },
  {
    // 改配置；**打开时立即跑一轮**，关闭时取消排程并中断进行中一轮
    method: 'PUT',
    path: '/autocheckin',
    handler: async ({ res, body, user }) => {
      try {
        const autock = require('../../qoder/autocheckin');
        const s = autock.configure(body || {});
        try {
          require('../auth').audit(user && user.username, 'qoder_autocheckin_config',
            s.enabled ? 'on' : 'off',
            `${s.hour}:${String(s.minute).padStart(2, '0')} jitter=${s.jitter_minutes}m include_intl=${s.include_intl}`);
        } catch (e) { /* 忽略 */ }
        return sendJSON(res, 200, { ok: true, ...s });
      } catch (e) {
        return sendJSON(res, 400, { ok: false, error: e.message });
      }
    },
  },
  {
    // 立即跑一轮（不依赖开关状态）。**触发式**：一轮要打上游若干次，
    // 同步 await 会把 HTTP 挂在超时上；结果靠 GET /autocheckin 轮询。
    method: 'POST',
    path: '/autocheckin/run',
    handler: async ({ res }) => {
      try {
        const autock = require('../../qoder/autocheckin');
        autock.runOnce('manual').catch(() => { /* 轮内失败已落 last_result */ });
        return sendJSON(res, 200, { ok: true, started: true });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    },
  },
];

module.exports = { routes, effective, RESTART_FIELDS };
