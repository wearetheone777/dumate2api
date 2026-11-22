// src/port-probe.js - 启动前的端口占用检查（P2-10）
//
// 出处：docs/WORKBUDDY-FUSION.md P2-10（hub `--probe-only`）：
// 「端口能连上但一直不答」不该被当成空闲——**Windows 的 SO_REUSEADDR 允许重复
// 监听**，内核把新连接分给先绑定的旧实例，于是你新起的那个进程永远收不到请求，
// 表现为「看板一直是空的」「接口返回旧数据」，而且进程活着、日志干净。
//
// 判据分三层（顺序即优先级）：
//   1. **能连上就算占用**（哪怕 HTTP 不回话）：`connect` 成功即证明有监听者。
//      只看「有没有 HTTP 响应」会漏掉卡死的旧实例——那正是最需要拦的情形。
//   2. 若它回了 `/health`，把 `service` / `role` 读出来报给人看（本仓库四个进程
//      的 /health 都带这两个字段，见 service-identity.js）。
//   3. 拿不到/不是 JSON：如实说「有监听者但不回本服务的 /health」。
//
// 只做检测，不 kill：杀进程是使用者的决定（与前几次的纪律一致）。启动脚本读到
// 非零退出码会打印提示，人自己决定是「先 stop 再 start」还是改端口。
const http = require('http');

/** /health 探测超时：本机回环，1.5s 足够；卡死的实例正是靠这个上限暴露 */
const DEFAULT_TIMEOUT_MS = 1500;

/**
 * 解析 /health 返回体 → { service, role } 或 null。
 * 宽容：不是 JSON、缺字段都返回 null（如实报「不认识的监听者」）。
 */
function parseHealth(body) {
  try {
    const j = JSON.parse(String(body || ''));
    if (!j || typeof j !== 'object') return null;
    const service = typeof j.service === 'string' ? j.service : '';
    const role = typeof j.role === 'string' ? j.role : '';
    if (!service && !role) return null;
    return { service, role };
  } catch (e) {
    return null;
  }
}

/**
 * 探测端口是否有人监听。
 * @param {string} host
 * @param {number} port
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{occupied:boolean, health:object|null, note:string}>}
 *   occupied=true 表示**不要继续 listen**（会变成重复绑定）
 */
function probe(host, port, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request(
      { host: host || '127.0.0.1', port, path: '/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; if (raw.length > 8192) raw = raw.slice(0, 8192); });
        res.on('end', () => {
          const health = parseHealth(raw);
          done({
            occupied: true,
            health,
            note: health
              ? `已有本仓库实例在监听（service=${health.service || '?'} role=${health.role || '?'}）`
              : `端口被占用，但 /health 不是本服务的响应（HTTP ${res.statusCode}）——可能是别的程序或卡死的旧实例`,
          });
        });
      },
    );
    req.on('timeout', () => {
      // 连上了但不回话：仍是占用（这正是「卡死旧实例」的典型形态）
      req.destroy();
      done({ occupied: true, health: null, note: '端口有监听者但 /health 无响应（疑卡死的旧实例）' });
    });
    req.on('error', (e) => {
      // ECONNREFUSED = 没人监听，端口空闲；其它错误按「不确定」处理但**不拦启动**
      // （例如权限受限的探测失败不该阻止正常启动）
      if (e && e.code === 'ECONNREFUSED') {
        return done({ occupied: false, health: null, note: '' });
      }
      done({ occupied: false, health: null, note: `端口探测失败（按空闲处理）: ${e && e.message}` });
    });
    req.end();
  });
}

/** 是否启用启动前探测（`DUMATE_PORT_PROBE=0` 关闭；默认开） */
function enabled() {
  const v = String(process.env.DUMATE_PORT_PROBE == null ? '' : process.env.DUMATE_PORT_PROBE).trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

module.exports = { DEFAULT_TIMEOUT_MS, parseHealth, probe, enabled };
