// test/unit/workbuddy-activity.test.js - 国内版对话活跃上报（growth 连登）
//
// hub wb_tasks.build_event('chat') / report_events / fetch_streak_days 融合
// （2026-11-04）。打桩出站 http 层（activity._setRequestImpl），锁住：
//   - 事件形状（eventCode/userId/modelId 等字段逐一对齐 hub 字面）；
//   - code===0 判定、连登回读（data.streak.days）、当日幂等（lastActivityReport）；
//   - 缺 uid 时跳过（hub 口径：不带 userId 的事件被静默丢弃，白发无意义）。
// 运行：node --test test/unit/workbuddy-activity.test.js
const assert = require('assert');
const { test } = require('node:test');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-wb-act');
process.env.DUMATE_ADMIN_DATA = TMP; // 在 require 之前

const activity = require('../../src/workbuddy/activity');

const ACCOUNT = {
  id: 9951, uid: 'uid-act-1', nickname: '活跃账号', region: 'cn',
  accessToken: 'at', refreshToken: 'rt', domain: 'copilot.tencent.com',
  enabled: true,
};

/** fake https.request：按 path 前缀分流，捕获请求体 */
function fakeHttp(script) {
  return function fakeRequest(opts, cb) {
    const req = {
      headers: opts.headers,
      _body: '',
      setEncoding() {},
      on(ev, cb2) { if (ev === 'error') this._errCb = cb2; return this; },
      write(b) { this._body += String(b); },
      end() {
        setImmediate(() => {
          const pathName = opts.path || '';
          const body = script.serve(pathName, req._body, req);
          if (body === undefined) return; // 剧本决定不发响应（超时场景）
          const res = {
            statusCode: 200,
            setEncoding() {},
            on(ev, cb2) {
              if (ev === 'data') setImmediate(() => cb2(body));
              if (ev === 'end') setImmediate(() => cb2());
              return res;
            },
          };
          cb(res);
        });
      },
      destroy() {},
    };
    return req;
  };
}

test('buildChatEvent：形状逐字段对齐 hub build_event("chat")', () => {
  const ev = activity.buildChatEvent({ uid: 'u1' });
  assert.strictEqual(ev.eventCode, 'chat_request_send');
  assert.strictEqual(ev.userId, 'u1');
  assert.strictEqual(ev.mode, 'craft');
  assert.strictEqual(ev.reportDelay, 0);
  assert.strictEqual(ev.isPlan, false);
  assert.strictEqual(ev.agentName, 'default');
  assert.strictEqual(ev.agentType, 'conversation');
  assert.strictEqual(ev.requestModelId, 'deepseek-v4-flash');
  assert.ok(ev.conversationId.startsWith('wb-task-'));
  assert.ok(ev.requestId.startsWith(ev.conversationId));
});

test('reportActivity：缺 uid 时跳过（不带 userId 的事件被上游静默丢弃）', async () => {
  const r = await activity.reportActivity({ id: 1, region: 'cn' });
  assert.strictEqual(r.ok, false);
  assert.ok(/uid/.test(r.error));
});

test('reportActivity：当日幂等（lastActivityReport 是今天 → skipped）', async () => {
  const d = new Date();
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const a = { ...ACCOUNT, lastActivityReport: `${local} 09:00:00` };
  const r = await activity.reportActivity(a, { authStore: { patch() {} } });
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.ok, true);
});

test('reportActivity：上报成功 + 连登回读 + 档案落 lastActivityReport', async () => {
  const seen = {};
  activity._setRequestImpl(fakeHttp({
    serve(pathName, body) {
      if (pathName.endsWith('/v2/report')) {
        seen.report = JSON.parse(body);
        seen.headers = null;
        return JSON.stringify({ code: 0 });
      }
      if (pathName.endsWith('/activity/growth/streak')) {
        seen.streak = true;
        return JSON.stringify({ code: 0, data: { streak: { days: 3 } } });
      }
      return JSON.stringify({ code: 1 });
    },
  }));
  const patched = {};
  const a = { ...ACCOUNT };
  const r = await activity.reportActivity(a, {
    authStore: { patch: (id, p) => { patched[id] = p; Object.assign(a, p); } },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.skipped, false);
  assert.strictEqual(r.streakDays, 3);
  assert.ok(/连续打卡 3 天/.test(r.msg), r.msg);
  assert.strictEqual(seen.report[0].eventCode, 'chat_request_send');
  assert.strictEqual(seen.report[0].userId, 'uid-act-1');
  assert.ok(seen.streak);
  assert.ok(patched[ACCOUNT.id] && patched[ACCOUNT.id].lastActivityReport, '档案应记录上报时间');
});

test('reportActivity：上游 code≠0 如实失败', async () => {
  activity._setRequestImpl(fakeHttp({
    serve() { return JSON.stringify({ code: 403, message: 'denied' }); },
  }));
  const r = await activity.reportActivity({ ...ACCOUNT, lastActivityReport: '' }, { authStore: { patch() {} } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('reportActivity：streak 查询失败 → ok 但 verified=false（送达≠计入）', async () => {
  // 2026-11-08 真机实测：/v2/report **不校验凭证**，假 accessToken 也回
  // {"code":0,"msg":"OK"}；而同一假 token 打 /activity/growth/streak 是 401。
  // 所以 code===0 只证明「POST 被接了」，不能证明「事件被计入连登」。
  // 旧实现把它当成成功并在 error 里留空——凭证失效的账号会每天「成功」
  // 一次而连登一天不涨，且从结果里完全看不出来。
  activity._setRequestImpl(fakeHttp({
    serve(pathName) {
      if (pathName.endsWith('/v2/report')) return JSON.stringify({ code: 0, msg: 'OK' });
      return 'not-json';   // 回读失败（401 HTML / 非 JSON）
    },
  }));
  const patched = {};
  const r = await activity.reportActivity(
    { ...ACCOUNT, lastActivityReport: '' },
    { authStore: { patch: (id, p) => { patched[id] = p; } } },
  );
  assert.strictEqual(r.ok, true, '请求确实送达了');
  assert.strictEqual(r.verified, false, '但没能验证是否计入');
  assert.strictEqual(r.streakDays, null);
  assert.ok(/无法验证/.test(r.msg), r.msg);
  assert.ok(r.error, '未验证必须有原因，不能留空冒充成功');
  // 送达即记档案：明天不该为「回读失败」重发同一条事件
  assert.ok(patched[ACCOUNT.id] && patched[ACCOUNT.id].lastActivityReport, '送达后仍要记幂等档案');
});
