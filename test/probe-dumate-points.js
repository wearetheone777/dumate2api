// test/probe-dumate-points.js - 积分钱包字段名的真机探针（P0-3 前置）
//
// 为什么需要它：P0-3（积分按 product 分池）的三个字段名——`product`、
// `status`、`pointsExpireDate`——是社区 2026-11-13 从**他们自己的账号**响应里
// 读出来的，本仓从未在自己账号上见过（我们的账号可能根本没有 comate 包）。
// 按纪律：字段名没核对过就不改展示逻辑，否则会把「字段不存在」误判成
// 「余额为 0」，正是 CLAUDE.md 里写的「余额 null ≠ 0」那类事故。
//
// 本脚本**只读**：只打 quota_overview，不发对话、不喂池、不改账号状态。
//
// 用法：
//   node test/probe-dumate-points.js            # 用账号池里第一个账号
//   node test/probe-dumate-points.js <account-id>
//
// 产物：data/probe-dumate-points.json（raw 全文 + 字段存在性报告）
const fs = require('fs');
const path = require('path');

const accounts = require('../src/accounts');
const web = require('../src/dumate-web');

const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
const OUT = path.join(DATA_DIR, 'probe-dumate-points.json');

async function main() {
  const want = process.argv[2] || '';
  const list = accounts.list() || [];
  if (!list.length) {
    console.error('账号池是空的。先在管理端「账号」页加一个网页凭证账号（或用桌面登录态导入）。');
    process.exit(2);
  }
  const acct = want ? list.find((a) => a.id === want || a.name === want) : list[0];
  if (!acct) {
    console.error(`没有 id/name 为 ${want} 的账号。现有：${list.map((a) => `${a.id}(${a.name || '-'})`).join(', ')}`);
    process.exit(2);
  }
  // cookie 是私有字段（toPublic 不外传），这里直接取原始记录
  const raw = accounts.getRaw(acct.id) || accounts.get(acct.id);
  const cookie = raw && raw.cookie;
  if (!cookie) {
    console.error(`账号 ${acct.id} 上没有可用 cookie（可能是桌面凭证账号，见 docs/CREDENTIALS-ACCOUNTS.md）`);
    process.exit(2);
  }

  console.log(`账号：${acct.id} / ${acct.name || '-'}`);
  // quotaOverview 挂在 dumate-web 的 api 对象上（模块导出是 { api, ... }）
  const r = await web.api.quotaOverview(cookie);
  if (!r.ok) {
    console.error(`quota_overview 失败：${r.error}${r.expired ? '（凭证已过期）' : ''}`);
    process.exit(3);
  }

  // ---- 字段存在性报告：P0-3 要用的三个字段名逐个核对 ----
  let usedOfActive = 0;
  const packs = [].concat(r.raw && r.raw.subscription || [], r.raw && r.raw.incremental || []);
  const has = (k) => packs.some((p) => p && Object.prototype.hasOwnProperty.call(p, k));
  const report = {
    at: new Date().toISOString(),
    account: { id: acct.id, name: acct.name || '' },
    totals: { total: r.total, used: r.used, left: r.left, subscribed: r.subscribed },
    pack_count: packs.length,
    fields: {
      product: has('product'),
      status: has('status'),
      pointsExpireDate: has('pointsExpireDate'),
      expireDate: has('expireDate'),
      startDate: has('startDate'),
      packageType: has('packageType'),
      source: has('source'),
      totalPoints: has('totalPoints'),
      usedPoints: has('usedPoints'),
    },
    // 按 product 分组求和（字段不存在时就是一行 'undefined'）
    by_product: {},
    by_status: {},
    active_dumate_total: 0,
    all_total: 0,
  };
  for (const p of packs) {
    const prod = String((p && (p.product ?? 'dumate')) ?? 'dumate');
    const st = String((p && p.status) ?? 'undefined');
    const t = Number((p && p.totalPoints) || 0);
    report.by_product[prod] = (report.by_product[prod] || 0) + t;
    report.by_status[st] = (report.by_status[st] || 0) + t;
    report.all_total += t;
    if (prod === 'dumate' && (p.status === undefined || p.status === 'active')) {
      report.active_dumate_total += t;
      usedOfActive += Number((p && p.usedPoints) || 0);
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ report, raw: r.raw, packages: r.packages }, null, 2), 'utf8');

  console.log('\n字段存在性：');
  for (const [k, v] of Object.entries(report.fields)) console.log(`  ${v ? '有' : '无'}  ${k}`);
  console.log('\n按 product 分组的 totalPoints：', report.by_product);
  console.log('按 status 分组的 totalPoints  ：', report.by_status);
  console.log(`\n报告口径对比：`);
  console.log(`  quota_overview 的 totalPoints      = ${r.total}`);
  console.log(`  active && product=dumate 的合计    = ${report.active_dumate_total}`);
  console.log(`  所有包合计                          = ${report.all_total}`);
  console.log(`\nraw 已落盘：${OUT}`);
  // 判读口径（2026-11-15 真机更正）：**不能拿「active 合计 ≠ totalPoints」当虚报**
  //
  // 真机发现：`status:"used"` 的包（used==total，left 0）仍然计入顶层 totalPoints，
  // 于是 active 合计必然小于 total——但它们的 used 也同样计入 usedPoints，两边抵消，
  // 所以 `totalPoints − usedPoints` 才是对的可用余额。本账号实测：
  //   total 14920 − used 4943.72 = 9976.28；active 合计 10140 − 其中已用 163.72 = 9976.28（一致）
  // 真正会虚报的是社区那种情形：**inactive（未来期）的包被计入 total 而不计入 used**。
  // 所以判据只能是比较两个余额口径：
  const bySubtract = r.total - r.used;
  const byActiveLeft = report.active_dumate_total - usedOfActive;
  const gap = Math.abs(bySubtract - byActiveLeft);
  console.log(`\n判读：`);
  console.log(`  · total − used          = ${bySubtract.toFixed(2)}`);
  console.log(`  · active 合计 − active已用 = ${byActiveLeft.toFixed(2)}`);
  console.log(`  · 两个口径差            = ${gap.toFixed(2)} ${gap <= 0.01 ? '（一致 → 现有余额口径正确，不需要改展示）' : '（不一致 → 存在虚报，要按 active 口径修）'}`);
  if (!report.fields.product) console.log('  · 没有 product 字段 → 本账号没有混其他产品的包，分池是「未来兼容」');
  else console.log(`  · product 取值：${JSON.stringify(report.by_product)}（只有 dumate 说明无混池）`);
  if (!report.fields.pointsExpireDate) console.log('  · 没有 pointsExpireDate → FEFO 只能继续用 expireDate（如实标注口径）');
  if (report.by_status && report.by_status.used !== undefined) {
    console.log(`  · status:"used" 的包共 ${report.by_status.used} 分：已用完但仍计入 totalPoints，靠 usedPoints 抵消`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
