// test/verify-checkin-workbuddy.js - 签到详情接入 WorkBuddy（离线，不需要起服务）
//
// 背景：`checkin-ledger` 从 P0-1 起就有 workbuddy 的记录（autocheckin 写），
// 但 `/api/admin/checkin/detail` 的通道白名单只有三条老通道——账本里有数据、
// 页面看不到，是典型的「写了没人读」。本批把它接上，两件事必须锁住：
//
//   1. channel=workbuddy 不再 400，且账号表来自 workbuddy 账号池；
//   2. **国际版账号标 unsupportedCheckin**（上游没有签到接口）——账号照列，
//      不能让人把「上游不支持」误读成「这号一直没签到」。
//
// 运行：node test/verify-checkin-workbuddy.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { tmpDir } = require('./helpers/tmpdir');
const TMP = tmpDir('dumate-ck-wb');
process.env.DUMATE_ADMIN_DATA = TMP;

const wbAuth = require('../src/workbuddy/auth');
const ledger = require('../src/checkin-ledger');
const { routes } = require('../src/admin/routes/checkin');

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`✔ ${name}`); }
  catch (e) { fail++; console.log(`✖ ${name}: ${e.message}`); }
}

function callDetail(query) {
  const r = routes.find((x) => x.method === 'GET' && x.path === '/detail');
  return new Promise((resolve, reject) => {
    const req = { url: `/detail?${query}`, method: 'GET', headers: {} };
    const res = {
      _code: 0,
      writeHead(c) { this._code = c; },
      end(t) { try { resolve({ status: this._code, body: JSON.parse(t) }); } catch (e) { resolve({ status: this._code, body: t }); } },
    };
    Promise.resolve(r.handler({ req, res, body: null, params: [], user: { role: 'admin' } })).catch(reject);
  });
}

(async () => {
  // 账号池：一个国内、一个国际
  wbAuth.upsert({
    uid: 'cn-1', region: 'cn', accessToken: 'a', refreshToken: 'r', nickname: '国内号', enabled: true,
  });
  wbAuth.upsert({
    uid: 'intl-1', region: 'global', accessToken: 'a', refreshToken: 'r', nickname: '国际号', enabled: true,
  });
  const cn = wbAuth.list().find((a) => a.region === 'cn');
  const intl = wbAuth.list().find((a) => a.region === 'global');

  // 账本：给国内号记两天签到（今天 + 昨天）
  const now = Date.now();
  const today = ledger.dayOf(now);
  const yesterday = ledger.dayOf(now - 86400000);
  ledger.appendMany([
    { channel: 'workbuddy', account_id: cn.id, account: '国内号', day: today, at: now, credits: 20, source: 'enable' },
    { channel: 'workbuddy', account_id: cn.id, account: '国内号', day: yesterday, at: now - 86400000, credits: 20, source: 'manual' },
  ]);

  const d = new Date();
  const r = await callDetail(`channel=workbuddy&year=${d.getFullYear()}&month=${d.getMonth() + 1}`);

  await check('channel=workbuddy 不再 400（从白名单外进白名单）', () => {
    assert.strictEqual(r.status, 200, `实际 ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.strictEqual(r.body.channel, 'workbuddy');
  });

  await check('账号来自 workbuddy 账号池（两个都在列）', () => {
    const names = r.body.accounts.map((a) => a.name).sort();
    assert.deepStrictEqual(names, ['国内号', '国际号'].sort());
  });

  await check('国际版标 unsupportedCheckin + region，国内版不标', () => {
    const cnRow = r.body.accounts.find((a) => a.id === cn.id);
    const intlRow = r.body.accounts.find((a) => a.id === intl.id);
    assert.strictEqual(cnRow.unsupportedCheckin, false);
    assert.strictEqual(cnRow.region, 'cn');
    assert.strictEqual(intlRow.unsupportedCheckin, true, '国际版上游没有签到接口');
    assert.strictEqual(intlRow.region, 'global');
  });

  await check('账本里的两天被渲染出来（今天已签）', () => {
    const cnRow = r.body.accounts.find((a) => a.id === cn.id);
    assert.ok(cnRow.days[today], '今天应出现');
    assert.ok(cnRow.days[yesterday], '昨天应出现');
    assert.strictEqual(cnRow.days[today].credits, 20);
    assert.strictEqual(cnRow.days[today].source, 'enable');
    assert.strictEqual(cnRow.checkedToday, true);
    assert.strictEqual(cnRow.daysInMonth >= 2, true);
  });

  await check('note 如实说明「上游不提供历史 + 国际版不支持」', () => {
    assert.match(r.body.note, /不提供签到历史/);
    assert.match(r.body.note, /国际版没有签到接口/);
    assert.match(r.body.note, new RegExp(r.body.coverage.ledgerSince || today));
  });

  await check('coverage 覆盖起点取到账本最早一天', () => {
    assert.strictEqual(r.body.coverage.ledgerSince, yesterday);
    assert.ok(r.body.coverage.since <= yesterday);
  });

  await check('其它通道不受影响（traework 仍 200，qwenwork 仍 400）', async () => {
    const tw = await callDetail('channel=traework');
    assert.strictEqual(tw.status, 200);
    const qw = await callDetail('channel=qwenwork');
    assert.strictEqual(qw.status, 400, '千问没有签到体系，仍应 400');
  });

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉无所谓 */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('验证异常:', e); process.exit(1); });
