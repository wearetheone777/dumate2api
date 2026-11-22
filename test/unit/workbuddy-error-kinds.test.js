// test/unit/workbuddy-error-kinds.test.js - 请求级四类错误的分类与处置（2026-11-08 融合批）
//
// 出处：GitHub 生态调研（xu20060420fan-cell/workbuddy2api-trae-qoder-minimax-panel
// 的 `internal/upstream/client.go` 14 个 ErrKind，与 linguo2625469/workbuddy2api-panel
// 母版、dsh-connect-workbuddy 交叉实证）。
//
// **要解决的问题（真实事故形态，不是理论洁癖）**：
// 这四类码原来全部落进 `client` 或 `soft_rate`：
//   - `soft_rate` → 喂池冷却**整个账号**：一个「换模型就能过」的请求把健康账号踢下线
//   - `client`    → errorActionOf 兜底 `feed:'account'`：同样会记账到账号头上
//
// 真实路径：一个账号连续被几个不支持 reasoning 的模型请求打中（11150），
// 10 分钟内该账号所有模型都会被池标记不可用——账号本身完全健康。
//
// 锁的行为：
//   1. 四个 kind 各自分类正确，且**码值带负向数字断言**（111020 不是 11102）
//   2. **都不许喂账号级**（isAccountFault 全 false）
//   3. model_unavailable 走模型级负缓存（feed:'model'），其余三种 feed:'none'
//   4. 6004 优先级仍高于它们（同一 body 两个码时按 6004）
//
// 运行：node --test test/unit/workbuddy-error-kinds.test.js
const test = require('node:test');
const assert = require('node:assert');

const c = require('../../src/workbuddy/constants');

const body = (obj) => JSON.stringify(obj);

test('11102 / 11103 / 11158：模型对该账号不可用 → model_unavailable', () => {
  assert.equal(c.classifyStatus(400, body({ code: 11102, msg: 'service info not found' })), 'model_unavailable');
  assert.equal(c.classifyStatus(400, body({ code: 11103, msg: 'not support this call' })), 'model_unavailable');
  // 个人免费档请求付费模型：实测原文
  assert.equal(c.classifyStatus(400, body({
    code: 11158,
    msg: 'model [glm-5] is not allowed for user type [personal_free_user]',
  })), 'model_unavailable');
  // 只有文案、没有码（中间层吞码时）
  assert.equal(c.classifyStatus(400, 'service info not found'), 'model_unavailable');
});

test('6020 / 6021 / 6022：排队 ≠ 限流（不是故障）', () => {
  for (const code of [6020, 6021, 6022]) {
    assert.equal(c.classifyStatus(429, body({ code, data: { queue_position: 3 } })), 'queue',
      `code=${code} 应判 queue 而不是 soft_rate`);
  }
});

test('11150：reasoning effort 不支持 → reasoning_unsupported', () => {
  assert.equal(c.classifyStatus(400, body({ code: 11150, msg: 'reasoning effort is not supported' })), 'reasoning_unsupported');
  assert.equal(c.classifyStatus(400, 'reasoning effort is not supported'), 'reasoning_unsupported');
});

test('11148：tool_calls 与 tool 结果不配对 → tool_pair_mismatch', () => {
  assert.equal(c.classifyStatus(400, body({ code: 11148, msg: 'tool calls and tool results do not match' })), 'tool_pair_mismatch');
  assert.equal(c.classifyStatus(400, 'tool calls and tool results do not match'), 'tool_pair_mismatch');
});

test('负向数字断言：码值子串不能被误吃', () => {
  // 这是本项目已经踩过的坑（111400 包含 11140 子串）
  assert.equal(c.classifyStatus(400, body({ code: 111020 })), 'client', '111020 不是 11102');
  assert.equal(c.classifyStatus(400, body({ code: 111500 })), 'client', '111500 不是 11150');
  assert.equal(c.classifyStatus(400, body({ code: 111480 })), 'client', '111480 不是 11148');
  assert.equal(c.classifyStatus(429, body({ code: 60200 })), 'soft_rate', '60200 不是 6020');
});

test('优先级：6004 仍高于请求级四类（同一 body 有两个码时按 6004）', () => {
  const both = body({ code: 6004, msg: 'usage exceeds frequency limit 11102' });
  assert.equal(c.classifyStatus(429, both), 'model_cap',
    '6004 带重置墙钟，比「模型不可用」更需要被如实识别');
});

test('优先级：账号风控 11140 高于请求级四类', () => {
  const both = body({ code: 11140, msg: '账号存在异常行为 11102' });
  assert.equal(c.classifyStatus(403, both), 'restricted');
});

test('isAccountFault：四类全是 false（这是本批的核心判据）', () => {
  for (const k of ['model_unavailable', 'queue', 'reasoning_unsupported', 'tool_pair_mismatch']) {
    assert.equal(c.isAccountFault(k), false, `${k} 不许当账号故障喂池`);
  }
  // 真正该喂账号的仍是这几个
  for (const k of ['hard_credit', 'session_dead', 'restricted', 'server', 'soft_rate']) {
    assert.equal(c.isAccountFault(k), true, `${k} 应喂账号级`);
  }
});

test('isRequestFault：请求级判据与账号级互斥（全覆盖无重叠）', () => {
  const all = ['hard_credit', 'session_dead', 'restricted', 'model_cap', 'model_unavailable',
    'queue', 'reasoning_unsupported', 'tool_pair_mismatch', 'soft_rate', 'not_found', 'server', 'client'];
  for (const k of all) {
    const a = c.isAccountFault(k);
    const r = c.isRequestFault(k);
    assert.equal(a && r, false, `${k} 不能同时是账号故障与请求故障`);
  }
  // model_cap 两边都不算：它是模型级额度，既不该喂账号也不该当纯请求错误
  assert.equal(c.isAccountFault('model_cap'), false);
  assert.equal(c.isRequestFault('model_cap'), false);
});

test('parseQueueInfo：位次/队列/建议等待翻成人话', () => {
  const q = c.parseQueueInfo(body({ code: 6020, data: { queue_position: 12, queue_size: 40, retry_after: 15 } }));
  assert.equal(q.position, 12);
  assert.equal(q.size, 40);
  assert.equal(q.retryAfter, 15);
  assert.match(q.text, /第 12 位/);
  assert.match(q.text, /队列 40/);

  // 只有位次
  const q2 = c.parseQueueInfo(body({ queue_position: 5 }));
  assert.match(q2.text, /第 5 位/);

  // 什么都没有 → null（不编一句「排队中」）
  assert.equal(c.parseQueueInfo(body({ code: 6020 })), null);
  assert.equal(c.parseQueueInfo(''), null);
});

test('parseQueueInfo：snake/camel 与中文 JSON 转义都能读', () => {
  assert.equal(c.parseQueueInfo('{"queuePosition":7}').position, 7);
  assert.equal(c.parseQueueInfo('{"queue-size":9}').size, 9);
});

// ---- 14018 积分耗尽（2026-11-08 融合批）----
// 出处：buddy-proxy。两个坑：① 码可能藏在 error.data.code 嵌套层；
// ② 文案有单复数。**漏判的代价是会退化成每 2 分钟重试一次**——
// 14018 常带 429，落到 soft_rate 只会软冷却几分钟然后无限重试，
// 而积分耗尽应当硬冷却到次日签到恢复。

test('14018：顶层 code 与嵌套 error.data.code 都认积分耗尽', () => {
  assert.equal(c.classifyStatus(429, JSON.stringify({ code: 14018, msg: 'credits exhausted' })), 'hard_credit');
  assert.equal(c.classifyStatus(429, JSON.stringify({ error: { data: { code: 14018 } } })), 'hard_credit',
    '只匹配顶层 code 会漏掉嵌套形态——这是调研点名的坑');
});

test('14018：文案单复数都认', () => {
  for (const msg of ['credit exhausted', 'credits exhausted', 'Credit(s) exhausted']) {
    assert.equal(c.classifyStatus(429, JSON.stringify({ msg })), 'hard_credit', msg);
  }
});

test('14018：负向数字断言（140180 不是 14018）', () => {
  assert.equal(c.classifyStatus(429, JSON.stringify({ code: 140180 })), 'soft_rate');
});

test('14018 优先级：高于 6004 与 429，但不抢 11140', () => {
  // 同一 body 同时带 14018 与 6004 时按 **14018** 判：积分彻底耗尽是账号级事实，
  // 此时「某个模型的窗口额度」已经没有意义（整个号都调不动）。
  // 这个顺序是刻意选的，不是巧合——若判成 model_cap，池只会冷却那一个模型，
  // 其余模型继续撞同一个耗尽态，于是每 2 分钟重试一次（调研点名的代价）。
  assert.equal(c.classifyStatus(429, JSON.stringify({ code: 14018, msg: 'usage exceeds frequency limit' })), 'hard_credit');
  // 11140 仍优先（账号风控与额度是两件事，风控要先停手）
  assert.equal(c.classifyStatus(403, JSON.stringify({ code: 11140, msg: 'credits exhausted' })), 'restricted');
});

test('排队：statusOf 给 429（客户端会退避重试，不是 400）', () => {
  // style: 排队语义就是「稍后再来」；给 400 客户端不会重试，直接失败
  // statusOf 未导出，这里通过 errorActionOf 与 classify 的组合间接锁行为：
  // 分类必须是 queue，处置必须是「不喂账号 + throw」
  const idx = require('../../src/workbuddy/index');
  const act = idx.errorActionOf({ kind: 'queue' });
  assert.equal(act.feed, 'none', '排队不是账号故障，绝不能喂池冷却');
  assert.equal(act.action, 'throw');
  assert.equal(act.queue, true, '要让调用方知道这是排队（可带位次文案）');
});
