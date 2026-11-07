// src/proxy-agent.js - per-account 出站代理（施工包 E / GAP F8）
//
// 对齐目标：codebuddyManager 的 per-account 出站代理（proxyroutes.py）。
// dumate 四通道上游请求目前全部直连——同一出口 IP 挂一批账号是风控敏感
// 场景的实际运营风险。这里提供两个东西：
//   1. HttpConnectAgent：零依赖的 HTTPS-over-HTTP-CONNECT 隧道 agent
//      （http.request({method:'CONNECT'}) 打洞 → tls.connect 复用洞内
//      socket → 交给 https.request 的 createConnection）；
//   2. agent 工厂：getAgentFor(account) 按「账号 proxy 字段 > 全局默认」
//      解析代理并返回缓存的 agent，无代理返回 null（直连）。
//
// 接线由集成阶段完成（通道出口 https.request 处注入 agent；本包不碰
// web-pool.js / upstream-router.js）。接入方约定：
//   - account 是**原始记录**（accounts.load()/getRaw() 的元素，proxy 字段
//     全量可用）；toPublic 出来的 proxy 是脱敏的，不能拿去连接。
//   - 账号配了代理就绝不回退直连：解析失败直接抛错 → 上游请求失败 →
//     账号按既有失败路径进入冷却。静默回退等于把真实出口 IP 裸奔出去。
//
// 范围（按 GAP 建议）：首版仅 http:// 代理（CONNECT 隧道）。socks5 与
// 「代理自身走 TLS」后续再加；纯 http 目标（非 TLS）不支持——四通道
// 上游全部是 https，不存在这个路径。
//
// 凭证纪律：proxy URL 可能带 user:pass。落盘跟随账号所在文件（0600 +
// fileperm 加固，accounts.js 既有模式）；**任何日志/对外形状都必须经过
// redactProxyUrl / describeProxy**，原始 URL 只在内存里用于建连。
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const crypto = require('crypto');

// CONNECT 打洞阶段的超时。TLS 握手与请求阶段的超时由调用方的请求
// timeout 控制，这里只管「连上代理并拿到 200」这一段。
const DEFAULT_CONNECT_TIMEOUT_MS = 15000;

// agent 缓存上限。每账号一个代理 URL 是常态，100 个代理对这个规模的
// 网关足够；超过按 FIFO 淘汰（Map 保插入序）。
const AGENT_CACHE_MAX = 100;

/** 全局默认代理：启动时读 env，运行期可用 setGlobalProxy 热更（livecfg 接入点） */
let globalProxy = normalizeOptional(process.env.DUMATE_PROXY || '');

function normalizeOptional(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return s;
}

/**
 * 把 URL 里的 user:pass 打码。任何落日志的场景都必须过这里。
 * 解析失败时用正则盲打码，不回显原文——失败的输入同样可能含凭证。
 */
function redactProxyUrl(raw) {
  const s = String(raw || '');
  try {
    const u = new URL(s);
    if (u.username || u.password) {
      const userinfo = u.username ? `${u.username}:***` : ':***';
      const rest = `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
      return `${u.protocol}//${userinfo}@${rest}`;
    }
    return s;
  } catch (e) {
    return s.replace(/\/\/[^@/\s]*@/, '//***@');
  }
}

/**
 * 校验并归一化代理地址，非法直接抛错（账号保存时就暴露配置错误）。
 * 返回存储形态：http://[user[:pass]@]host[:port]，缺省端口 80、路径与
 * query 一律丢弃（CONNECT 只用 authority，带路径反而让归一化形态漂移）。
 */
function normalizeProxyUrl(input) {
  const s = normalizeOptional(input);
  if (!s) throw new Error('proxy 不能为空');
  let u;
  try { u = new URL(s); }
  catch (e) { throw new Error(`proxy 不是合法 URL：${redactProxyUrl(s)}`); }
  if (u.protocol !== 'http:') {
    throw new Error(`proxy 仅支持 http:// 形式的代理地址（首版不支持 ${u.protocol.replace(/:$/, '')}）`);
  }
  if (!u.hostname) throw new Error('proxy 缺少主机名');
  let port = 80;
  if (u.port !== '') {
    port = Number(u.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('proxy 端口不合法');
  }
  // 畸形 percent-encoding（如 '%zz'）不该让整条配置报不出可读错误——
  // 解不出就按字面量收编，凭证校验交给代理服务器自己拒
  const decodeSafe = (v) => { try { return decodeURIComponent(v); } catch (e) { return v; } };
  const auth = (u.username || u.password)
    ? `${encodeURIComponent(decodeSafe(u.username))}:${encodeURIComponent(decodeSafe(u.password))}`
    : '';
  return `http://${auth ? `${auth}@` : ''}${formatHost(u.hostname)}${port === 80 ? '' : `:${port}`}`;
}

/** IPv6 字面量在 CONNECT authority / http host 里必须带方括号 */
function formatHost(host) {
  return net.isIP(host) === 6 ? `[${host}]` : host;
}

/** 解析成连接参数（内部用；外部校验/存储请走 normalizeProxyUrl） */
function parseProxy(raw) {
  const u = new URL(normalizeProxyUrl(raw));
  return {
    host: u.hostname,
    port: u.port === '' ? 80 : Number(u.port),
    auth: (u.username || u.password)
      ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) }
      : null,
  };
}
/**
 * 经代理打一条 CONNECT 隧道，resolve 洞内的**裸 socket**（未 TLS）。
 * 工厂 agent 用它 + tls.connect 组装 createConnection；测试用它直接
 * 验证隧道（配明文 TCP 目标即可，不必起 TLS 服务）。
 *
 * opts.connectTimeout：CONNECT 阶段超时（毫秒），默认 15s。
 */
function connectViaProxy(proxy, targetHost, targetPort, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = typeof proxy === 'string' ? parseProxy(proxy) : proxy;
    const authority = `${formatHost(targetHost)}:${targetPort}`;
    const headers = { host: authority };
    if (p.auth) {
      // 凭证只进 Authorization 头，不进任何错误消息/日志
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${p.auth.user}:${p.auth.pass}`).toString('base64')}`;
    }
    let settled = false;
    const req = http.request({
      host: formatHost(p.host),
      port: p.port,
      method: 'CONNECT',
      path: authority,
      headers,
      // agent:false：CONNECT 的洞内 socket 绝不能进任何连接池
      agent: false,
      timeout: opts.connectTimeout || DEFAULT_CONNECT_TIMEOUT_MS,
    });
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch (e) { /* 已断 */ }
      reject(err);
    };
    req.on('connect', (res, socket, head) => {
      if (settled) { socket.destroy(); return; }
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`代理 CONNECT 被拒绝：HTTP ${res.statusCode}${res.statusMessage ? ` ${res.statusMessage}` : ''}`));
        return;
      }
      settled = true;
      // 200 之后 SOCKS/HTTP 隧道内可能已有目标侧先发来的字节（如服务器
      // hello），塞回流头部让 TLS 层按序读到
      if (head && head.length) socket.unshift(head);
      // 摘掉请求阶段的超时，避免洞内空闲连接被 CONNECT 超时误杀
      socket.setTimeout(0);
      resolve(socket);
    });
    req.on('timeout', () => fail(new Error(`代理 CONNECT 超时（${opts.connectTimeout || DEFAULT_CONNECT_TIMEOUT_MS}ms）`)));
    req.on('error', fail);
    req.end();
  });
}

/**
 * HTTPS-over-CONNECT 隧道 agent。给 https.request 的 agent 选项用：
 * createConnection 拿到洞内裸 socket 后立即 tls.connect，返回的
 * TLSSocket 语义与 https.Agent 默认（直连 + tls.connect）一致，连接
 * 池化、超时、错误传播都走 Node 原生机制。
 */
class HttpConnectAgent extends https.Agent {
  constructor(proxyUrl, opts = {}) {
    const { connectTimeout, ...agentOpts } = opts;
    super(agentOpts);
    this.proxy = parseProxy(proxyUrl);
    this.connectTimeout = connectTimeout || DEFAULT_CONNECT_TIMEOUT_MS;
  }

  createConnection(options, callback) {
    connectViaProxy(this.proxy, options.host, options.port, { connectTimeout: this.connectTimeout })
      .then((socket) => {
        // tls.connect 极少数情况会同步抛（非法 TLS 选项）：必须毁掉洞内
        // socket 并把错误交给 callback，否则请求悬挂到自身超时、隧道泄漏
        let tlsSock;
        try {
          const tlsOpts = { ...options, socket };
          // SNI 不允许 IP 字面量（RFC 6066，Node 会警告并将拒绝），IP 直连
          // 目标不设 servername，与 https.Agent 默认行为一致
          if (!tlsOpts.servername && net.isIP(options.host) === 0) tlsOpts.servername = options.host;
          tlsSock = tls.connect(tlsOpts);
        } catch (e) {
          socket.destroy();
          callback(e);
          return;
        }
        // 与 https.Agent 默认 createConnection 相同：同步返回 TLSSocket，
        // 握手错误经 socket error 事件传到请求方
        callback(null, tlsSock);
      })
      .catch(callback);
  }
}

/**
 * 代理池：按账号稳定哈希分配出口（调研 P2-15 / Coding2API 的 CREDENTIAL_PROXY_POOL）。
 *
 * 为什么需要：同一出口 IP 挂一批账号是风控敏感场景——上游看到的是「一个 IP
 * 上十几个号在轮着用」，比单号异常更容易被整体处置。让每个账号固定走自己的
 * 出口，把「一批号」拆成「几个互不相关的个体」。
 *
 * 三个设计要点：
 *   1. **稳定哈希，不是轮询**（`sha256(channel:id) % len`）：重启、增删别的账号
 *      都不能让某个账号的出口漂移——出口跳变本身就是异常信号。同一账号永远
 *      落在同一个下标上。
 *   2. **账号自己的 proxy 字段优先**：显式配置永远压过池子，否则用户手填的
 *      出口会被悄悄改掉。池子只补「没配 proxy 的账号」。
 *   3. **池子为空 = 保持原行为**（直连/全局代理），不引入任何变化。
 *
 * 池子来源 `DUMATE_PROXY_POOL`（逗号或换行分隔的 http:// 代理列表）。
 * 非法条目在启动时就抛错（fail-fast），不静默跳过——跳过会让「以为配了 8 个
 * 出口、实际只有 3 个」这种事故无从发现。
 */
let proxyPool = [];

function setProxyPool(list) {
  const items = Array.isArray(list) ? list : String(list || '').split(/[,\n]/);
  const out = [];
  for (const raw of items) {
    const s = normalizeOptional(raw);
    if (!s) continue;
    // 逐条校验：非法条目直接抛，不静默跳过（见上面第 3 点）
    out.push(normalizeProxyUrl(s));
  }
  proxyPool = out;
  clearAgentCache();
  return proxyPool.slice();
}

function getProxyPool() {
  return proxyPool.slice();
}

/** 池子里的稳定分配：返回规范化代理 URL；池空返回 null。key 形如 `traework:3` */
function poolProxyFor(key) {
  if (!proxyPool.length) return null;
  const h = crypto.createHash('sha256').update(String(key)).digest();
  return proxyPool[h.readUInt32BE(0) % proxyPool.length];
}

/**
 * 解析账号生效的代理 URL：**账号 proxy 字段 > 代理池（稳定哈希）> 全局默认**，
 * 皆无 → null。account 也可以直接传代理 URL 字符串（接线点更顺手）。
 * 注意返回的是**含凭证的原始 URL**，只用于建连；落日志用 describeProxy。
 */
function resolveProxyUrl(account) {
  const own = typeof account === 'string' ? account
    : (account && typeof account === 'object' ? normalizeOptional(account.proxy) : '');
  if (own) return own;
  // 代理池只补「没配 proxy 的账号」，且必须按账号稳定落点。
  // 键位里要带通道：各通道的 id 是各自文件里的自增数字，qa 的 1 与 traework
  // 的 1 是两个不同账号，只用 id 会让它们固定挤在同一个出口上。
  // **通道不接受账号对象自带字段**——调用方传的是原始账号记录，多数字段没有
  // channel。用 `__channel` 显式传入（接线点已按通道分包，加一个字段比改
  // 几十处调用便宜），缺省回落到 'acct'（池仍然稳定，只是跨通道可能共享）。
  if (account && typeof account === 'object' && account.id != null) {
    const channel = normalizeOptional(account.__channel || '');
    const key = `${channel || 'acct'}:${account.id}`;
    const pooled = poolProxyFor(key);
    if (pooled) return pooled;
  }
  return globalProxy || null;
}

/** 账号生效代理的**脱敏**形态，落日志/上报用：null（直连）或 'http://user:***@h:8080' */
function describeProxy(account) {
  const url = resolveProxyUrl(account);
  if (!url) return null;
  try { return redactProxyUrl(normalizeProxyUrl(url)); }
  catch (e) { return redactProxyUrl(url); }
}

/**
 * agent 工厂（给集成阶段）：按账号返回 https 请求可用的 agent。
 *   - 无代理 → null（调用方不加 agent，直连）
 *   - 配置非法 → 抛错（见文件头：绝不静默回退直连）
 * agent 按归一化代理 URL 缓存，同代理共享连接池（TLS 握手复用）；
 * 首次构造时的 opts 生效，后续命中缓存忽略 opts。
 */
const agentCache = new Map();

function getAgentFor(account, opts = {}) {
  const url = resolveProxyUrl(account);
  if (!url) return null;
  const normalized = normalizeProxyUrl(url);
  let agent = agentCache.get(normalized);
  if (!agent) {
    if (agentCache.size >= AGENT_CACHE_MAX) {
      const oldest = agentCache.keys().next().value;
      agentCache.delete(oldest);
    }
    agent = new HttpConnectAgent(normalized, opts);
    agentCache.set(normalized, agent);
  }
  return agent;
}

/** 热更全局默认代理（livecfg / 管理端接入点）。空串=清除，null=不动由调用方决定 */
function setGlobalProxy(url) {
  const s = normalizeOptional(url);
  if (s) normalizeProxyUrl(s); // 先校验，非法抛错不落状态
  globalProxy = s;
  return globalProxy;
}

function getGlobalProxy() {
  return globalProxy;
}

/** 清空 agent 缓存（测试与全局代理热更后调用；存量 agent 自行失效） */
function clearAgentCache() {
  agentCache.clear();
}

module.exports = {
  DEFAULT_CONNECT_TIMEOUT_MS,
  HttpConnectAgent,
  connectViaProxy,
  normalizeProxyUrl,
  redactProxyUrl,
  resolveProxyUrl,
  describeProxy,
  getAgentFor,
  setGlobalProxy,
  getGlobalProxy,
  setProxyPool,
  getProxyPool,
  poolProxyFor,
  clearAgentCache,
};

// 启动时从 env 装载代理池。放在文件末尾而不是第 41 行附近：setProxyPool 用到
// 的 normalizeProxyUrl / clearAgentCache 都是函数声明（会提升），但把「初始化
// 副作用」集中在一处更容易审计——谁在什么时候改了进程级状态一目了然。
// DUMATE_PROXY_POOL 非法条目会在这里抛错（fail-fast），与全局代理同一纪律。
if (normalizeOptional(process.env.DUMATE_PROXY_POOL || '')) {
  setProxyPool(process.env.DUMATE_PROXY_POOL);
}
