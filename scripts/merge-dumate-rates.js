// scripts/merge-dumate-rates.js - 把「双点解斜率」的测量结果并进倍率缓存
//
// 为什么需要这一步：`test/probe-dumate-rates.js` 产出的是 `data/probe-dumate-rates.json`
// （一份测量报告，按**模型名**记），而模型信息表读的是 `data/dumate-rate-cache.json`
// （按**真实后端**记，7 天 TTL）。两者键不同，必须显式合并——让 dumateRows 同时读
// 两份文件才是坏设计：两份数据必然漂移。
//
// 键用 `modelmap.backendOf(模型名)`：同后端的名字（model-text / deepseek-v41-flash /
// text.L0 / mm.L0）只写一次价，天然一致，不会出现「同一后端四个不同数字」。
//
// 用法：node scripts/merge-dumate-rates.js [probe 文件路径]
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.DUMATE_ADMIN_DATA || path.join(ROOT, 'data');
const IN = process.argv[2] || path.join(DATA, 'probe-dumate-rates.json');

const billing = require(path.join(ROOT, 'src', 'dumate-billing'));
const modelmap = require(path.join(ROOT, 'src', 'modelmap'));

function main() {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(IN, 'utf8'));
  } catch (e) {
    console.error(`读不到测量结果：${IN}（先跑 node test/probe-dumate-rates.js --all）`);
    process.exit(2);
  }
  const rows = Array.isArray(report.rows) ? report.rows : [];
  if (!rows.length) {
    console.error('测量结果里没有 rows');
    process.exit(2);
  }

  // **测量时刻按报告本身记，不用合并时刻**（review #11）：把两周前的探针
  // 报告并进来时，Date.now() 等于伪造「刚测过」，让旧价格再权威 7 天。
  // 报告顶层的 at 是 ISO 时间；单行若带 measuredAt 则优先（补测场景）。
  const reportAt = Date.parse(report.at || '') || 0;
  if (!reportAt) {
    console.log('警告：报告没有可解析的 at 时间，条目将按合并时刻记（TTL 从今天起算）');
  }
  let written = 0;
  const skipped = [];
  for (const r of rows) {
    if (!r || !r.model) continue;
    if (r.error || !Number.isFinite(r.pointsPerKOut) || r.pointsPerKOut <= 0) {
      skipped.push(`${r.model}${r.error ? '（' + r.error.slice(0, 40) + '）' : '（无有效斜率）'}`);
      continue;
    }
    const backend = modelmap.backendOf(r.model);
    const measuredAt = Number(r.measuredAt) || reportAt || 0;
    const entry = {
      ...(measuredAt ? { measuredAt } : {}),
      pointsPerKOut: r.pointsPerKOut,
      pointsPerKIn: r.pointsPerKIn == null ? null : r.pointsPerKIn,
      unit: 'pts/1k_out',
      source: 'two-point',
      tokens: r.tokens || '',
      // 写清是哪个名字测的——同后端共用一个价，但「谁测的」要能追
      probedWith: r.model,
      account: report.account ? `${report.account.id}/${report.account.name}` : '',
    };
    if (billing.saveRateEntry(backend, entry)) written++;
  }

  console.log(`写入 ${written} 条（键=真实后端）→ ${billing.rateCachePath()}`);
  if (skipped.length) console.log(`跳过 ${skipped.length} 条：${skipped.join('；')}`);
  const cache = billing.readRateCache();
  console.log(`\n缓存现有条目：${Object.keys(cache).length}`);
  for (const [k, v] of Object.entries(cache)) {
    const val = Number.isFinite(v.pointsPerKOut) ? `${v.pointsPerKOut} 积分/千out` : (Number.isFinite(v.billed) ? `${v.billed} 积分/千tok（老口径）` : '—');
    console.log(`  ${k.padEnd(42)} ${val}`);
  }
}

main();
