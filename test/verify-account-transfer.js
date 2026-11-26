// test/verify-account-transfer.js - 账号导入/导出的离线验证
//
// 不依赖网关与上游：在临时数据目录里造五个通道的账号，跑「导出 → 导入 →
// 再导出」的往返，验证白名单、冲突策略、区域归一化与错误隔离。
//
// 重点锁住的几条不变量（都是「错了会静默」的）：
//   1. 导出体里**不能有 id / lastError**——id 会撞号，lastError 是源机状态
//   2. 导入的 id **必须由目标机重新分配**，不能沿用文件里的值
//   3. 缺必填字段的条目被逐条拒掉，其余条目照常导入（不是整包失败）
//   4. skip 不覆盖、overwrite 覆盖
//   5. 区域按通道自己的术语归一化（traework=cn/intl，qoder/workbuddy=cn/global）
//   6. 主账号标记排他：目标池已有 preferred 时不认导入记录里的标记
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'd2a-transfer-'));
process.env.DUMATE_ADMIN_DATA = DIR;

const transfer = require('../src/account-transfer');

let failures = 0;
function check(label, ok, extra) {
  if (!ok) failures++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok || extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
}

function reset() {
  for (const f of fs.readdirSync(DIR)) {
    if (f.endsWith('.json') || f.endsWith('.lock')) fs.unlinkSync(path.join(DIR, f));
  }
}

function readFile(name) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')); }
  catch (e) { return { accounts: [] }; }
}

const sample = {
  kind: 'dumate2api-accounts',
  version: 1,
  channels: {
    dumate: { accounts: [
      { id: 77, cookie: 'BDUSS=aaa; STOKEN=s1', name: '搭子甲', uid: 'd1', nickname: '甲', lastError: 'stale' },
      { cookie: 'no-bduss=1', name: '坏号' },
    ] },
    qwenwork: { accounts: [
      { uid: 'q1', nickname: 'Q', accessToken: 'qa', refreshToken: 'qr', preferred: true, id: 55 },
    ] },
    traework: { accounts: [
      { uid: 't1', nickname: 'T', region: 'intl', accessToken: 'ta', refreshToken: 'tr' },
      { nickname: '缺uid', accessToken: 'x', refreshToken: 'y' },
    ] },
    qoder: { accounts: [
      { uid: 'o1', nickname: 'O', region: 'cn', accessToken: 'oa', refreshToken: 'or', machineId: 'm' },
      { uid: 'o2', nickname: 'O2', accessToken: 'oa2', refreshToken: 'or2' },
    ] },
    workbuddy: { accounts: [
      { uid: 'w1', nickname: 'W', region: 'intl', accessToken: 'wa', refreshToken: 'wr', domain: 'workbuddy.ai', source: 'manual' },
    ] },
  },
};

console.log('== 导入：白名单 / 错误隔离 / 区域归一化 ==');
reset();
const r1 = transfer.importPayload(JSON.parse(JSON.stringify(sample)), {});
check('整包导入成功', r1.ok === true, r1.error);
check('8 条收到，6 条成功，2 条失败', r1.totals.received === 8 && r1.totals.created === 6 && r1.totals.failed === 2, r1.totals);
check('搭子缺 BDUSS 被逐条拒掉', r1.channels.find((c) => c.channel === 'dumate').failed === 1);
check('TRAE 缺 uid 被拒', r1.channels.find((c) => c.channel === 'traework').failed === 1);
check('错误信息指出第几条与原因', /#2 .*BDUSS/.test(r1.channels.find((c) => c.channel === 'dumate').errors[0]),
  r1.channels.find((c) => c.channel === 'dumate').errors);

const tw = readFile('traework-accounts.json').accounts[0];
check('TRAE 区域 intl 原样保留', tw && tw.region === 'intl', tw && tw.region);
const qd = readFile('qoder-accounts.json').accounts;
check('Qoder 记录没带区域时按国内（不是 global 默认）', qd.find((a) => a.uid === 'o2').region === 'cn',
  qd.map((a) => [a.uid, a.region]));
const wb = readFile('workbuddy-accounts.json').accounts[0];
check('WorkBuddy intl 归一化成 global', wb && wb.region === 'global', wb && wb.region);
check('导入的 id 由目标机分配（不是文件里的 77/55）',
  readFile('web-accounts.json').accounts[0].id !== 77 && readFile('qwenwork-accounts.json').accounts[0].id !== 55);

console.log('');
console.log('== 导出：不含 id / lastError，凭证完整 ==');
const e1 = transfer.exportPayload({});
check('导出成功', e1.ok === true);
const allRows = Object.values(e1.payload.channels).flatMap((c) => c.accounts);
check('导出条数 = 导入成功条数（6）', allRows.length === 6, allRows.length);
check('导出体没有任何 id 字段', allRows.every((a) => !('id' in a)));
check('导出体没有任何 lastError 字段', allRows.every((a) => !('lastError' in a) && !('lastErrorAt' in a)));
const dq = e1.payload.channels.dumate.accounts[0];
check('搭子导出带 cookie 明文（迁移必需）', dq.cookie === 'BDUSS=aaa; STOKEN=s1', dq.cookie);
check('搭子导出带 uid/nickname', dq.uid === 'd1' && dq.nickname === '甲');
const qwRow = e1.payload.channels.qwenwork.accounts[0];
check('千问导出带 access/refresh token', qwRow.accessToken === 'qa' && qwRow.refreshToken === 'qr');
check('导出带 createdAt（目标机算账号存活天数）', typeof allRows[0].createdAt === 'number');

console.log('');
console.log('== 冲突策略 ==');
const r2 = transfer.importPayload(e1.payload, { mode: 'skip' });
check('skip：全部跳过', r2.totals.skipped === 6 && r2.totals.created === 0 && r2.totals.updated === 0, r2.totals);
const r3 = transfer.importPayload(e1.payload, { mode: 'overwrite' });
check('overwrite：全部更新', r3.totals.updated === 6 && r3.totals.created === 0, r3.totals);

console.log('');
console.log('== 主账号排他 ==');
reset();
transfer.importPayload({ channels: { qwenwork: { accounts: [
  { uid: 'a', accessToken: 'x', refreshToken: 'y', preferred: true },
] } } }, {});
const r4 = transfer.importPayload({ channels: { qwenwork: { accounts: [
  { uid: 'b', accessToken: 'x2', refreshToken: 'y2', preferred: true },
] } } }, {});
check('第二个带 preferred 的导入不产生两个主账号', r4.ok === true);
const qwAcc = readFile('qwenwork-accounts.json').accounts;
check('池里恰好一个 preferred', qwAcc.filter((a) => a.preferred).length === 1,
  qwAcc.map((a) => [a.uid, a.preferred]));

console.log('');
console.log('== 形状校验：坏包整包拒，不做半导入 ==');
check('裸数组无 channel → 拒', transfer.importPayload([{ uid: 'x' }], {}).ok === false);
check('未知通道 → 拒', transfer.importPayload({ channels: { nope: { accounts: [] } } }, {}).ok === false);
check('kind 不符 → 拒', transfer.importPayload({ kind: 'other', channels: {} }, {}).ok === false);
check('版本过高 → 拒', transfer.importPayload({ version: 999, channels: { qoder: { accounts: [] } } }, {}).ok === false);
check('channels 值不是数组 → 拒', transfer.importPayload({ channels: { qoder: { accounts: 'x' } } }, {}).ok === false);
const r5 = transfer.importPayload([{ uid: 'z', accessToken: 'a', refreshToken: 'b' }], { channel: 'qoder' });
check('裸数组 + 显式 channel → 可导入', r5.ok === true && r5.totals.created === 1, r5);

console.log('');
console.log('== 导出参数 ==');
check('未知通道导出 → 拒', transfer.exportPayload({ channel: 'nope' }).ok === false);
const e2 = transfer.exportPayload({ channel: 'qoder' });
check('单通道导出只含该通道', Object.keys(e2.payload.channels).length === 1 && e2.payload.channels.qoder);
const e3 = transfer.exportPayload({ channel: 'traework', region: 'intl' });
check('按区域导出：只留 intl 账号', e3.payload.channels.traework.accounts.every((a) => a.region === 'intl'));

console.log('');
console.log('== 接口鉴权：四条路由都只对 admin 开放 ==');
// 路由层：router 的默认规则是「非 GET 才要 admin」，而本组三条读接口是 GET——
// 只守 /export 会让 viewer 读到 /summary 与 /fields，等于功能对 viewer 可见。
const { routes: transferRoutes } = require('../src/admin/routes/account-transfer');
function callRoute(route, user) {
  const res = {
    headersSent: false, status: 0, body: '',
    writeHead(s) { this.status = s; this.headersSent = true; },
    end(b) { this.body = b || ''; },
  };
  route.handler({ res, req: { url: route.path }, body: {}, user, params: [] });
  return res;
}
const admin = { username: 'a', role: 'admin' };
const viewer = { username: 'v', role: 'viewer' };
for (const route of transferRoutes) {
  const asViewer = callRoute(route, viewer);
  const asAnon = callRoute(route, null);
  check(`${route.method} ${route.path} 对 viewer 返回 403`, asViewer.status === 403, asViewer.status);
  check(`${route.method} ${route.path} 对未登录返回 403`, asAnon.status === 403, asAnon.status);
  const asAdmin = callRoute(route, admin);
  check(`${route.method} ${route.path} 对 admin 不返回 403`, asAdmin.status !== 403, asAdmin.status);
}

console.log('');
console.log('== 概览 ==');
const sum = transfer.summarize();
check('概览覆盖五条通道', sum.length === 5 && sum.every((s) => s.channel && typeof s.total === 'number'));
check('概览不含任何凭证字段', JSON.stringify(sum).indexOf('refreshToken') === -1 && JSON.stringify(sum).indexOf('cookie') === -1);

// 清理
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

console.log('');
console.log(failures ? `${failures} 项失败` : '全部通过');
process.exit(failures ? 1 : 0);
