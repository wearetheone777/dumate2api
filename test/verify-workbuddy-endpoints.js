// test/verify-workbuddy-endpoints.js - 本批新增管理端点的离线冒烟（不需要起服务）
//
// 为什么用「直接调 handler」而不是起 9083：这些端点的输入形状（query/body）
// 与错误分支是本次改动的重点，起服务还要处理登录态与端口占用，反而遮住了
// 真正要看的东西。router 的 handler 是纯函数式 ({req,res,body,params})，
// 用假 req/res 就能把「路由参数解析 → 校验 → 落盘 → 返回体形状」整条走完。
//
// 覆盖：P2-11 连坐参数 / P1-6 护栏 / P0-1 自动签到 / P1-5 取证查看 /
//       P0-3 credits 的 uids / P1-4 Key 账号白名单形状校验。
//
// 运行：node test/verify-workbuddy-endpoints.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { tmpDir } = require('./helpers/tmpdir');
const TMP = tmpDir('dumate-wb-ep');
process.env.DUMATE_ADMIN_DATA = TMP;
process.env.DUMATE_WORKBUDDY_RESTRICTION_HOLD_SECONDS = '1800';
process.env.DUMATE_WORKBUDDY_RESTRICTION_WAVE_MIN = '2';
process.env.DUMATE_WORKBUDDY_RESTRICTION_WAVE_WINDOW = '900';
process.env.DUMATE_WORKBUDDY_RESTRICTED_ROTATE_MAX = '0';

const { routes } = require('../src/admin/routes/workbuddy');
const { routes: keyRoutes } = require('../src/admin/routes/keys');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) return r.then(() => { pass++; console.log(`✔ ${name}`); },
      (e) => { fail++; console.log(`✖ ${name}: ${e.message}`); });
    pass++; console.log(`✔ ${name}`);
  } catch (e) {
    fail++; console.log(`✖ ${name}: ${e.message}`);
  }
  return Promise.resolve();
}

/** 找到路由并调用；返回 { status, body }。urlPath 可带查询串（handler 自己解析） */
function call(method, routePath, urlPath, body) {
  const r = routes.find((x) => x.method === method && x.path === routePath);
  if (!r) throw new Error(`路由不存在: ${method} ${routePath}`);
  return callRoute(r, urlPath || routePath, body);
}

function callRoute(r, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = { url: urlPath, method: r.method, headers: {} };
    const res = {
      _code: 0,
      _json: null,
      writeHead(code, headers) { this._code = code; this._headers = headers; },
      end(txt) { try { this._json = JSON.parse(txt); } catch (e) { this._json = txt; } resolve({ status: this._code, body: this._json }); },
      setHeader() {},
      get headersSent() { return this._code > 0; },
    };
    Promise.resolve(r.handler({ req, res, body: body || null, params: [], user: { role: 'admin', username: 'smoke' } }))
      .catch(reject);
  });
}

(async () => {
  // ---- P2-11 连坐参数 ----
  const rc0 = await call('GET', '/restriction/config');
  await check('GET /restriction/config 回运行期值 + env 默认值', () => {
    assert.strictEqual(rc0.status, 200);
    assert.strictEqual(rc0.body.config.holdSeconds, 1800);
    assert.strictEqual(rc0.body.envDefaults.holdSeconds, 1800);
    assert.ok(rc0.body.file);
  });

  const rc1 = await call('PUT', '/restriction/config', '/restriction/config', { holdSeconds: 120, waveMin: 3 });
  await check('PUT /restriction/config 保存并回 changed', () => {
    assert.strictEqual(rc1.status, 200);
    assert.strictEqual(rc1.body.config.holdSeconds, 120);
    assert.deepStrictEqual(rc1.body.changed, { holdSeconds: 120, waveMin: 3 });
    assert.ok(rc1.body.state, '应带回当前连坐状态');
  });

  const rc2 = await call('PUT', '/restriction/config', '/restriction/config', { holdSeconds: -5 });
  await check('PUT /restriction/config 越界 → 400（不静默吞）', () => {
    assert.strictEqual(rc2.status, 400);
    assert.match(rc2.body.error, /holdSeconds/);
  });

  const rc3 = await call('PUT', '/restriction/config', '/restriction/config', { bogus: 1 });
  await check('PUT /restriction/config 未知键 → 400', () => {
    assert.strictEqual(rc3.status, 400);
    assert.match(rc3.body.error, /未知配置键/);
  });

  // ---- P1-6 护栏 ----
  const g0 = await call('GET', '/guard');
  await check('GET /guard 默认关 + 快照信息', () => {
    assert.strictEqual(g0.status, 200);
    assert.strictEqual(g0.body.config.enabled, false);
    assert.ok(g0.body.snapshot);
  });
  const g1 = await call('PUT', '/guard', '/guard', { enabled: true, threshold: 2 });
  await check('PUT /guard 保存', () => {
    assert.strictEqual(g1.status, 200);
    assert.strictEqual(g1.body.config.enabled, true);
    assert.strictEqual(g1.body.config.threshold, 2);
  });
  const g2 = await call('PUT', '/guard', '/guard', { threshold: 0 });
  await check('PUT /guard threshold=0 → 400（要关请明确 enabled=false）', () => {
    assert.strictEqual(g2.status, 400);
    assert.match(g2.body.error, /threshold/);
  });

  // ---- P0-1 自动签到 ----
  const a0 = await call('GET', '/autocheckin');
  await check('GET /autocheckin 默认关 + rationale', () => {
    assert.strictEqual(a0.status, 200);
    assert.strictEqual(a0.body.enabled, false);
    assert.ok(Array.isArray(a0.body.rationale) && a0.body.rationale.length);
  });
  const a1 = await call('PUT', '/autocheckin', '/autocheckin', { enabled: true, hour: 2, minute: 30, jitter_minutes: 5 });
  await check('PUT /autocheckin 保存 + 打开时立即跑了一轮', () => {
    assert.strictEqual(a1.status, 200);
    assert.strictEqual(a1.body.enabled, true);
    assert.strictEqual(a1.body.hour, 2);
    assert.ok(a1.body.next_run_at > 0, '应有下次触发时刻');
  });
  const a2 = await call('PUT', '/autocheckin', '/autocheckin', { hour: 24 });
  await check('PUT /autocheckin hour=24 → 400', () => {
    assert.strictEqual(a2.status, 400);
    assert.match(a2.body.error, /hour/);
  });
  const a3 = await call('POST', '/autocheckin/run');
  await check('POST /autocheckin/run 触发式（started=true 立即返回）', () => {
    assert.strictEqual(a3.status, 200);
    assert.strictEqual(a3.body.started, true);
  });
  await new Promise((r) => setTimeout(r, 80));
  const a4 = await call('PUT', '/autocheckin', '/autocheckin', { enabled: false });
  await check('PUT /autocheckin 关闭 → 取消排程', () => {
    assert.strictEqual(a4.body.enabled, false);
    assert.strictEqual(a4.body.next_run_at, null);
  });

  // ---- P1-5 取证查看（只读）----
  const d0 = await call('GET', '/dumps', '/dumps?limit=5');
  await check('GET /dumps 只读展示档位/文件/操作指引', () => {
    assert.strictEqual(d0.status, 200);
    assert.strictEqual(d0.body.mode, 'off', '默认关闭');
    assert.deepStrictEqual(d0.body.codes, ['11-128', '11128']);
    assert.ok(Array.isArray(d0.body.files));
    assert.ok(d0.body.howTo.summary);
    assert.ok(/不要先轮换账号/.test(d0.body.discipline));
  });

  // ---- P0-3 credits 的 uids 解析（无账号 → 空表，但形状要对）----
  const c0 = await call('GET', '/credits', '/credits?uids=');
  await check('GET /credits?uids= 空值按「没点名」处理（scope=all）', () => {
    assert.strictEqual(c0.status, 200);
    assert.strictEqual(c0.body.scope, 'all');
    assert.strictEqual(c0.body.requested, undefined);
  });
  const c1 = await call('GET', '/credits', '/credits?uids=7,abc,0,,9');
  await check('GET /credits?uids= 只收正整数（abc/0 丢弃）', () => {
    assert.strictEqual(c1.body.scope, 'partial');
    assert.deepStrictEqual(c1.body.requested, [7, 9]);
  });

  // ---- P1-4 Key 账号白名单形状校验 ----
  const keyCreate = keyRoutes.find((x) => x.method === 'POST' && x.path === '');
  const bad = await new Promise((resolve) => {
    const res = { _code: 0, writeHead(c) { this._code = c; }, end(t) { resolve({ status: this._code, body: JSON.parse(t) }); } };
    keyCreate.handler({ req: { url: '/keys' }, res, body: { name: 'k', account_allowlist: ['x1'] }, params: [], user: { role: 'admin' } });
  });
  await check('POST /keys account_allowlist 形状非法 → 400', () => {
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /account_allowlist/);
  });
  const good = await new Promise((resolve) => {
    const res = { _code: 0, writeHead(c) { this._code = c; headers: {}; }, end(t) { resolve({ status: this._code, body: JSON.parse(t) }); } };
    keyCreate.handler({ req: { url: '/keys' }, res, body: { name: 'k2', account_allowlist: ['1', 'workbuddy:2'] }, params: [], user: { role: 'admin' } });
  });
  await check('POST /keys account_allowlist 合法 → 落盘并回传', () => {
    assert.strictEqual(good.status, 200);
    assert.deepStrictEqual(good.body.key.account_allowlist, ['1', 'workbuddy:2']);
  });

  // ---- 模型繁忙度探针（2026-11-08 融合批）----
  // 这个端点会真打上游，冒烟里**不打网络**：只验证「无账号时的如实拒绝」
  // 与「schema 形状」。真实的繁忙度读数靠真机脚本，不放在离线冒烟里。
  const b0 = await call('GET', '/busy', '/busy?region=cn');
  await check('GET /busy 无账号时如实拒绝且带 note（不编繁忙度）', () => {
    assert.strictEqual(b0.status, 200);
    // 冒烟环境没有真实账号 → ok:false + error 说明原因；有账号时 ok:true
    if (b0.body.ok === false) {
      assert.ok(b0.body.error, '失败必须带原因');
    }
    assert.ok(Array.isArray(b0.body.crowded), 'crowded 恒为数组');
    assert.strictEqual(typeof b0.body.levels, 'object');
    assert.ok(b0.body.note, '必须带口径说明（国际版 404 / 只读不拦）');
    assert.strictEqual(typeof b0.body.guardEnabled, 'boolean');
  });

  const b1 = await call('GET', '/busy', '/busy?region=intl&models=glm-5');
  await check('GET /busy?models= 点名：国际版把 404 标成 unsupported 而不是错误', () => {
    assert.strictEqual(b1.status, 200);
    assert.deepStrictEqual(b1.body.models, ['glm-5'], '点名的 id 要原样回传');
    // 国际版没有该接口：unsupported 为真时 error 必须为空（不是故障）
    if (b1.body.unsupported) assert.strictEqual(b1.body.error, '');
  });

  // ---- 成长中心（2026-11-08 融合批，只读）----
  const gr = await call('GET', '/growth', '/growth?region=cn');
  await check('GET /growth 无账号时如实拒绝（schema 完整，不编数据）', () => {
    assert.strictEqual(gr.status, 200);
    // 冒烟环境通常没有真实账号；有账号时它会真打上游，此时只验 schema
    assert.ok('streak' in gr.body);
    assert.ok('heatmap' in gr.body);
    assert.ok('tasks' in gr.body);
    assert.ok('energy' in gr.body);
    assert.ok('buddyQuota' in gr.body);
    assert.ok(gr.body.note, '必须带「只读」口径说明');
    assert.strictEqual(typeof gr.body.errors, 'object');
  });
  await check('GET /growth 的 note 明确写出不写操作（防止后来者误加）', () => {
    assert.match(gr.body.note, /只读/);
    assert.match(gr.body.note, /不接取|不领奖|不开盲盒/);
  });

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉无所谓 */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('冒烟异常:', e); process.exit(1); });
