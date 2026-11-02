// test/verify-channel.js - 通道过滤 + 积分归因配对的离线验证
//
// 不依赖正在运行的网关/管理端：直接复用管理端路由与 qwenwork 模块，
// 用真实落盘数据（data/requests.jsonl、data/qwenwork-credits.jsonl）
// 跑一遍过滤与配对逻辑，把结果打出来。
//
// 用途：改完通道过滤或积分归因后，一条命令确认「搭子/千问的数字对得上」，
// 而不必手工点一遍四个页面。
const usage = require('../src/admin/routes/usage');
const reqlogs = require('../src/admin/routes/reqlogs');
const reqlog = require('../src/reqlog');

function fakeRes(cb) {
  return { writeHead() {}, end(b) { cb(JSON.parse(b)); } };
}

const usageHandler = usage.routes.find((r) => r.path === '/overview').handler;
const reqHandler = reqlogs.routes.find((r) => r.path === '').handler;

function call(handler, url) {
  return new Promise((resolve) => handler({ req: { url }, res: fakeRes(resolve) }));
}

let failures = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`[${mark}] ${label}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  // ---- 数据源基线 ----
  const { rows: all } = reqlog.read({ limit: 0 });
  const dist = {};
  for (const r of all) {
    const k = r.channel || '(无字段)';
    dist[k] = (dist[k] || 0) + 1;
  }
  console.log('数据源 requests.jsonl:', all.length, '条', JSON.stringify(dist));
  console.log('');

  // ---- 用量统计按通道过滤 ----
  const uDumate = await call(usageHandler, '/overview?days=90&channel=dumate');
  const uQw = await call(usageHandler, '/overview?days=90&channel=qwenwork');
  const uAll = await call(usageHandler, '/overview?days=90&channel=');

  console.log('--- 用量统计 ---');
  check('dumate 回显通道', uDumate.channel === 'dumate');
  check('qwenwork 回显通道', uQw.channel === 'qwenwork');
  check('单通道过滤时不返回 by_channel', uDumate.by_channel.length === 0 && uQw.by_channel.length === 0);
  check('全部通道时返回 by_channel', uAll.by_channel.length > 0, JSON.stringify(uAll.by_channel.map((c) => `${c.id}:${c.requests}`)));
  check('千问不查搭子上游账单', uQw.cards.today.consumed_points === null && uQw.points_by_account.length === 0);
  check('搭子仍查上游账单', uDumate.cards.today.consumed_points !== null);
  // 历史记录（无 channel）应归入搭子：搭子行数 = 显式 dumate + 无字段
  const expectDumate = (dist.dumate || 0) + (dist['(无字段)'] || 0);
  check('搭子行数含历史记录', uDumate.cards.week.requests <= expectDumate,
    `搭子本周 ${uDumate.cards.week.requests} ≤ 搭子总行 ${expectDumate}`);
  check('千问主力模型是 qwen/*', !uQw.cards.top_model || uQw.cards.top_model.startsWith('qwen/'),
    String(uQw.cards.top_model));
  console.log('');

  // ---- 请求日志按通道过滤 ----
  const rDumate = await call(reqHandler, '/?days=90&status=all&channel=dumate&limit=200&offset=0');
  const rQw = await call(reqHandler, '/?days=90&status=all&channel=qwenwork&limit=200&offset=0');

  console.log('--- 请求日志 ---');
  check('dumate 行全部是搭子（含历史）',
    rDumate.rows.every((r) => !r.channel || r.channel === 'dumate'));
  check('qwenwork 行全部是千问', rQw.rows.every((r) => r.channel === 'qwenwork'));
  check('qwenwork 回显通道', rQw.channel === 'qwenwork');
  console.log('');

  // ---- 千问积分归因配对 ----
  console.log('--- 千问积分归因（req_id 配对）---');
  const withCredits = rQw.rows.filter((r) => r.qw_total !== undefined);
  const withReqId = rQw.rows.filter((r) => r.req_id);
  console.log(`千问行 ${rQw.rows.length} 条；带 req_id ${withReqId.length} 条；配对到积分 ${withCredits.length} 条`);
  if (withCredits.length) {
    const sample = withCredits[0];
    console.log('  样本:', JSON.stringify({
      req_id: sample.req_id, model: sample.model, qw_total: sample.qw_total,
    }));
    // 2026-11-02：不再透出 qw_free / qw_paid / qw_pool——上游停发每日免费额度后
    // 新记录恒为 free=0、pool=paid，那三列只会显示一排零。历史行里的字段仍在
    // 账本里，只是不经接口外传。
    check('只透出 qw_total（不再拆免费/付费池）',
      sample.qw_free === undefined && sample.qw_paid === undefined && sample.qw_pool === undefined,
      `free=${sample.qw_free}, paid=${sample.qw_paid}, pool=${sample.qw_pool}`);
  } else {
    console.log('  （暂无配对样本：归因要等结算，或该请求在改动前发出）');
  }
  // 搭子行不应带千问积分字段
  check('搭子行不带千问积分字段', rDumate.rows.every((r) => r.qw_total === undefined));
  console.log('');

  console.log(failures === 0 ? '全部通过' : `${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})();
