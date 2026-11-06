// test/unit/probe-no-punish.test.js - 探针模式（opts.probe）失败不惩罚账号
//
// hub v1.7.20 #134 的教训（2026-11-04 融合）：billing-check 是「读健康状态」的
// 观测动作——撞 429/额度码时把账号写进冷却，等于健康检查把健康账号打成病人，
// 下一个真实请求在毫秒级被本地拒绝。本测试锁住两个行为：
//   1. 默认路径（回归锚）：失败仍按 classify 喂池（429 → 软冷却）；
//   2. probe: true：账号不进冷却、lastError 不写，错误照常上抛如实展示。
// 运行：node --test test/unit/probe-no-punish.test.js
const assert = require('assert');
const { test } = require('node:test');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-probe-'));
process.env.DUMATE_ADMIN_DATA = TMP; // 在 require 之前（grants/credits 落盘隔离）
const TMP_STATE = path.join(TMP, 'pool-state.json');
process.env.DUMATE_POOL_STATE = TMP_STATE;

const auth = require('../../src/qoder/auth');
const session = require('../../src/qoder/session');
const chat = require('../../src/qoder/chat');
const credits = require('../../src/qoder/credits');
const qoder = require('../../src/qoder/index');
const channelPool = require('../../src/channel-pool');
const { pool } = require('../../src/pool');

const ACCOUNT = {
  id: 9921, uid: 'uid-probe', nickname: '探针账号', region: 'cn',
  accessToken: 'at', refreshToken: 'rt',
  machineId: 'mid', machineToken: 'mtok', machineType: '5',
  enabled: true,
};
const MODELS = [{ key: 'gfmodel', name: 'GLM-5.3-Flash', maxInputTokens: 1000000 }];
const PAYLOAD = { model: 'qoder/gfmodel', messages: [{ role: 'user', content: 'hi' }] };

auth.findUsable = () => [ACCOUNT];
auth.preferred = () => ACCOUNT;
auth.patch = () => {};
session.ensureAccount = async () => ACCOUNT;
session.cachedModels = () => MODELS;
session.fetchModels = async () => ({ ok: true, models: MODELS });
credits.capture = () => {};

/** 429 非 SSE 错误体：真实 postStream 即使无数据帧也在流尾补 [DONE] */
chat.postStream = async (url, body, headers, onChunk) => {
  onChunk('[DONE]');
  return { status: 429, headers: {}, raw: '{"code":429,"message":"Too many requests"}' };
};
// 非流式路径（onChunk=null 的 send）走 chat.post——必须同样打桩，
// 否则测试会打到真实网络
chat.post = async (url, body, headers) => ({
  status: 429, headers: {}, raw: '{"code":429,"message":"Too many requests"}',
});

const usable = () => [ACCOUNT];

test('默认路径：429 失败仍喂池（账号进软冷却）——回归锚', async () => {
  pool.revive(`qoder:${ACCOUNT.id}`);
  await assert.rejects(() => qoder.send(PAYLOAD, null, { reqId: 't1' }));
  const av = channelPool.availability('qoder', usable(), { model: 'gfmodel' });
  assert.strictEqual(av.softOnly, true, '429 后应进入软冷却（现有行为）');
  pool.revive(`qoder:${ACCOUNT.id}`);
});

test('probe: true：429 失败不写冷却，错误照常上抛', async () => {
  pool.revive(`qoder:${ACCOUNT.id}`);
  let caught = null;
  try { await qoder.send(PAYLOAD, null, { reqId: 't2', probe: true }); }
  catch (e) { caught = e; }
  assert.ok(caught, '探针失败必须如实上抛，不能吞');
  assert.strictEqual(caught.statusCode, 429, String(caught && caught.statusCode));
  const av = channelPool.availability('qoder', usable(), { model: 'gfmodel' });
  assert.strictEqual(av.softOnly, false, 'probe 失败不得把账号写进软冷却');
  assert.strictEqual(av.usable, true, 'probe 失败后账号应仍可选');
  // 池里确实能再选到这个号（下一个真实请求不被毫秒级拒绝）
  const sel = channelPool.pickCandidate('qoder', usable(), { model: 'gfmodel' });
  assert.ok(sel, 'probe 失败后 pickCandidate 仍应选中该账号');
  channelPool.release(sel.uid);
  pool.revive(`qoder:${ACCOUNT.id}`);
});

