// src/qoder/clock.js - 上游时钟偏差检测（2026-11-01，对齐 qoder2api-hub issue #64）
//
// COSY 签名带时间戳，本机时钟漂移会让**每个请求都 401**——而且形态与
// 「凭证失效」一模一样（105/Login expired）。hub 的结论：这是「容器里莫名
// 失效」的常见原因，必须在启动自检里看得见，而不是让用户去换凭证。
//
// 测法（hub upstream_clock_skew 同款）：HEAD 一个**无鉴权**端点，读响应的
// `Date` 头，与本地时间求差。失败返回 null（fail-open）——测不出偏差不能
// 挡住任何请求，它只是排障信息。
//
// 阈值 120 秒取自 hub：签名时间戳的容差没有公开文档，hub 实测 2 分钟以上
// 必挂；120 秒内上游接受。不做校时——网关没有权限动系统时钟，只报告。
const https = require('https');

/** 偏差告警阈值（秒）：|skew| 超过它才值得报警 */
const WARN_THRESHOLD_S = 120;
/** 测量结果缓存时长（ms）。对齐 hub 的 10 分钟——偏差不会秒级变化 */
const CACHE_MS = 10 * 60 * 1000;

const HOSTS = {
  cn: 'openapi.qoder.com.cn',
  global: 'openapi.qoder.sh',
};

/**
 * 纯函数：RFC 7231 Date 头 → 偏差秒数（服务端 − 本地）。解析失败返回 null。
 * 独立导出便于离线验证（Date 头格式固定，不用打网络）。
 */
function skewFromHeader(dateHeader, nowMs) {
  if (!dateHeader) return null;
  const ts = Date.parse(String(dateHeader).trim());
  if (!Number.isFinite(ts)) return null;
  return Math.round(ts - (Number(nowMs) || Date.now())) / 1000;
}

const cache = new Map(); // region → { skewS, at }

/** 读缓存（不发请求）。没有/过期返回 null——调用方按「测不出」处理 */
function cachedSkewOf(region) {
  const e = cache.get(String(region || 'cn'));
  if (!e || Date.now() - e.at > CACHE_MS) return null;
  return e.skewS;
}

/**
 * 测一次指定区域的时钟偏差（带缓存）。只发 HEAD、无鉴权、超时 4 秒。
 * 网络失败/超时不覆盖旧缓存（旧值比「没有」更有用），但会过期失效。
 */
function measureSkew(region, opts = {}) {
  const key = String(region || 'cn');
  const host = HOSTS[key] || HOSTS.cn;
  if (!opts.force) {
    const cached = cachedSkewOf(key);
    if (cached != null) return Promise.resolve(cached);
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = https.request({ host, method: 'HEAD', path: '/', timeout: 4000 }, (res) => {
        res.resume();
        const skew = skewFromHeader(res.headers.date, Date.now());
        if (skew != null) cache.set(key, { skewS: skew, at: Date.now() });
        done(skew);
      });
      req.on('timeout', () => { try { req.destroy(); } catch (e) { /* 已结束 */ } done(cachedSkewOf(key)); });
      req.on('error', () => done(cachedSkewOf(key)));
      req.end();
    } catch (e) { done(cachedSkewOf(key)); }
  });
}

/** 这个偏差够不够格报警（|skew| 超阈值）。null 永远不报 */
function shouldWarn(skewS) {
  return skewS != null && Math.abs(skewS) > WARN_THRESHOLD_S;
}

/** 401 错误的偏差标注（有新鲜缓存且超标才带——测不出就不加话） */
function annotate401(region) {
  const skew = cachedSkewOf(region);
  if (!shouldWarn(skew)) return '';
  return `（机器时间偏差 ${skew > 0 ? '+' : ''}${Math.round(skew)}s：COSY 签名按时间戳校验，先校时再试，凭证未必失效）`;
}

module.exports = { skewFromHeader, measureSkew, cachedSkewOf, shouldWarn, annotate401, WARN_THRESHOLD_S };
