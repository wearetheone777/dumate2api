// test/probe-dumate-cloud-models.js - 个人版云端网关的模型名接受度真机探测
//
// 背景（2026-11-06，清单项「个人版模型目录对齐」）：社区项目
// magpie-dumate-enterprise 给出的云端模型表（kimi-k31 / glm-53 / glm-53-flash /
// deepseek-v4-pro / deepseek-v41-flash / qwen38-flash，1M 上下文）来自**企业租户**
// 的 POST /v1/model/list-all。个人版 /gateway/apis/v1 是否接受这些名字未实测——
// 本探针逐个发 max_tokens=1 的最小请求（probe 模式：失败不写惩罚态），用
// X-Dumate-Gw-Realmodel 响应头确认实际跑的模型。
//
// 运行：node test/probe-dumate-cloud-models.js   （需要 data/ 里有健康网页账号）
const pool = require('../src/web-pool');

const CANDIDATES = [
  // 基线：现状两条链路都在用的智能路由名
  'model-text',
  // 企业模型表的云端路由名
  'kimi-k31',
  'glm-53',
  'glm-53-flash',
  'deepseek-v4-pro',
  'deepseek-v41-flash',
  'qwen38-flash',
  // 社区对外别名（Alphaxiaoteng/dumate2api 的推荐模型名）
  'deepseek-v4.1',
  'kimi-k3.1-pro',
  'glm-5.3',
  'qwen-3.8-flash',
  // 本地链路真名（对照：云端是否同样接受后端名）
  'deepseek-v4.1-flash-low-latency',
  'glm-5.2',
];

(async () => {
  const snap = pool.snapshot();
  const ready = snap.filter((a) => a.enabled && !a.cooling && !a.disabled);
  if (!ready.length) {
    console.error('没有可用的健康网页账号，探针中止');
    process.exit(1);
  }
  console.log(`探针开始：${CANDIDATES.length} 个候选名，账号 ${ready.map((a) => a.name).join(' / ')}\n`);
  const rows = [];
  for (const model of CANDIDATES) {
    const r = await pool.callWithFailover('/chat/completions', 'POST', {
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      stream: false,
    }, { probe: true, maxAttempts: 1, timeout: 60000 });
    const real = (r.headers && r.headers['x-dumate-gw-realmodel']) || '';
    rows.push({ model, status: r.status, ok: r.ok, real: String(real) });
    console.log(
      `${r.ok ? '  ✓' : '  ✗'} ${model.padEnd(34)} HTTP ${r.status}` +
      (real ? `  realmodel=${real}` : '') +
      (r.ok ? '' : `  ${String(r.error || '').slice(0, 110)}`),
    );
  }
  console.log('\n汇总（JSON）：');
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
})().catch((e) => { console.error('probe error:', e); process.exit(1); });
