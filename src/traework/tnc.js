// src/traework/tnc.js - agent 网关的动态发现（TNC get_domains/v5）
//
// 背景（2026-10-15 抓包实测，实现细节对齐 misakano7545/traework2api-panel）：
// 官方客户端**不写死** agent 网关——它请求逻辑主机名（国服 trae-api-cn.mchost.guru），
// TTNet 按 TNC 下发的域名表在传输层改写成具体后端（api5-normal.mchost.guru）。
// 上游换分片时写死的基址就死——国服 2026-10-15 刚换过一轮。这里自己拉表解析，
// 让基址跟着上游走，而不是靠人肉盯梢。
//
// 免鉴权。aid 是两区不同的应用号（决定返回哪一区的表）；cronet/ttnet 版本串
// 不能空——实测清空会让响应退化成 0 条规则。响应形状：
//   {"data":{"ttnet_dispatch_actions":[{"param":{"host_group":["api5-normal.mchost.guru",…]}}]}}
// 国服条目无区域段（api5-normal），国际条目带（api22-normal-alisg）；同一张表
// 可能混含两区条目，按区域段过滤。排序按分片号**从大到小**（实测客户端用较新
// 分片）。2026-10-31 真机验证：国服表含 api3/api5-normal。
const c = require('./constants');

const BOOT_HOSTS = {
  cn: ['https://tnc0-aliec2.zijieapi.com', 'https://tnc3-bjlgy.zijieapi.com', 'https://tnc-boot.trae.ai'],
  intl: ['https://tnc-boot.trae.ai', 'https://tnc16-normal-sg.trae.ai'],
};
// aid 决定返回哪一区的表（国服 787976 = x-lscbd-aid，国际 677332 = x-ss-dp）
const QUERY = {
  cn: 'aid=787976&device_platform=windows&version_code=3402',
  intl: 'aid=677332&device_platform=windows&version_code=362',
};
const EXTRA = '&app_name=Trae&cronet_version=a61b3479_2026-08-04&ttnet_version=4.2.243.20-trae&tnc_src=1&delay=0';
const AGENT_HOST_RE = /^api(\d+)-normal(-[a-z0-9]+)?\.mchost\.guru$/;
const UA = 'TraeClient/TTNet';
const CACHE_MS = 10 * 60 * 1000;      // 表的缓存时长（上游换分片是低频事件）
const NEGATIVE_MS = 60 * 1000;        // 拉表失败的负缓存（别每个请求都去撞坏掉的 TNC）

const cache = new Map(); // region → { at, hosts: string[]|null }

/** 账号的地域：auth 记录的 region 字段（缺省 cn）；也接受直接的 region 串 */
function regionOf(x) {
  if (x === 'intl' || x === 'cn') return x;
  return x && x.region === 'intl' ? 'intl' : 'cn';
}

/** 拉一区的域名表；解析不出候选返回 null */
async function fetchAgentHosts(region) {
  for (const boot of BOOT_HOSTS[region] || BOOT_HOSTS.cn) {
    const r = await c.request(boot, '/get_domains/v5/?' + QUERY[region] + EXTRA, {
      method: 'GET',
      headers: { 'User-Agent': UA },
      timeout: 8000,
    });
    if (r.status !== 200 || !r.data || !r.data.data) continue;
    const acts = Array.isArray(r.data.data.ttnet_dispatch_actions) ? r.data.data.ttnet_dispatch_actions : [];
    const seen = new Set();
    const out = [];
    for (const a of acts) {
      const group = (a && a.param && a.param.host_group) || [];
      for (const h of group) {
        const s = String(h || '').trim();
        const m = AGENT_HOST_RE.exec(s);
        if (!m) continue;
        const hasRegion = !!m[2];
        if ((region === 'intl') !== hasRegion) continue;
        if (seen.has(s)) continue;
        seen.add(s);
        out.push({ host: s, n: Number(m[1]) });
      }
    }
    // 分片号从大到小（实测客户端用较新分片），同号按字母序稳定
    out.sort((a, b) => (b.n - a.n) || (a.host < b.host ? -1 : 1));
    if (out.length) return out.map((x) => 'https://' + x.host);
  }
  return null;
}

/**
 * 候选 agent 基址（TNC 表优先）。带 10 分钟缓存；拉表失败记 60 秒负缓存
 * （返回 null，调用方回落硬编码常量）——发现机制自己坏掉不能影响出流。
 * @returns {Promise<string[]|null>}
 */
async function agentHostCandidates(regionOrAuth) {
  const region = regionOf(regionOrAuth);
  const now = Date.now();
  const hit = cache.get(region);
  if (hit && now - hit.at < (hit.hosts ? CACHE_MS : NEGATIVE_MS)) return hit.hosts;
  let hosts = null;
  try { hosts = await fetchAgentHosts(region); } catch (e) { hosts = null; }
  cache.set(region, { at: now, hosts });
  return hosts;
}

/** 全部候选都连接失败后调：清缓存让下次请求重新拉表（表可能已过期） */
function invalidate(regionOrAuth) {
  cache.delete(regionOf(regionOrAuth));
}

/**
 * 完整候选基址链：TNC 表（新分片优先）→ 地区常量兜底，去重保序。
 * chat.postStream / models.fetchModels 共用——改轮转规则只改这里。
 */
async function agentHosts(regionOrAuth) {
  const region = regionOf(regionOrAuth);
  const list = [];
  try {
    const hosts = await agentHostCandidates(region);
    if (Array.isArray(hosts)) list.push(...hosts);
  } catch (e) { /* TNC 坏了不影响出流 */ }
  const primary = region === 'intl' ? c.AGENT_HOST_INTL : c.AGENT_HOST;
  if (!list.includes(primary)) list.push(primary);
  return list;
}

module.exports = { agentHostCandidates, agentHosts, invalidate, regionOf, fetchAgentHosts, BOOT_HOSTS, CACHE_MS };
