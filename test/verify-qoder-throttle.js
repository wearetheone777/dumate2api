// test/verify-qoder-throttle.js - Qoder 上游限流（排队）处置的离线验证
//
// ============================================================
// 为什么要有这个脚本
//
// 2026-10-23~27 实测：Qoder 上游限流会回
//   {"code":"10605","message":"{\"isQueued\":true,\"modelKey\":\"dfmodel\",
//    \"queueCount\":0,\"retryAfterSeconds\":30,\"serviceAvailable\":false,
//    \"subCode\":\"RESOURCE_LIMIT\"}"}
// 或者干脆「先响应后沉默」（qoder/chat.js 的 read idle 主动断开）。
//
// 旧实现把这**两种都当 breaker**（5xx/网络类熔断）处置，而熔断的退避是
// 30 分钟起步、每次翻倍。实测后果：两个账号各被限流 3 次 → 整个池被封
// 30 分钟，而用户侧看到的是「Qoder 用不了」——上游 30 秒后就恢复了。
//
// 四条不变量（改这里之前先读）：
//   1. 限流（RESOURCE_LIMIT / CALL_COUNT_LIMIT / isQueued / read idle）
//      **必须**归类成 soft，不能进 breaker——它带自己的重试时刻。
//   2. 上游给了 retryAfterSeconds / waitTime 就按它冷却（夹在 [1s, 封顶]），
//      不再套 5 分钟基数；**取不到才**回落基数。
//   3. 403 的限流必须**可换号**：排队粒度是 (账号, 模型)，换号能落到没排队的。
//   4. 失败全是限流时下游拿到 **429**（客户端会退避重试），不是 403/502/503。
//
// 手法：池用独立临时文件（DUMATE_POOL_STATE），qoder 的 auth/session/chat/credits
// 用模块导出覆盖打桩——不需要账号、不需要网络。
//
// 用法：node test/verify-qoder-throttle.js
// ============================================================
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// 必须在 require pool 之前设：单例是模块加载时按这个路径建的
const TMP_STATE = path.join(os.tmpdir(), `dumate-qoder-throttle-${process.pid}.json`);
process.env.DUMATE_POOL_STATE = TMP_STATE;
// 排队重试预算。测试里**要非零**（否则 `send` 一轮都不重试，锁不住
// 「挂起后快速轮询命中」这条用例）；6 秒是生产默认值，用例总耗时可控。
process.env.DUMATE_QODER_QUEUE_PATIENCE_MS = '6000';
// 重试间隔取默认 1500ms 会拖慢用例；压到 100ms，语义不变（只是让轮询更快）。
process.env.DUMATE_QODER_QUEUE_STEP_MS = '100';
// 选号顺序：本脚本多条例程按「先打 901、失败再换 902」断言，依赖**确定性**选号。
// 生产默认已改为加权抽签 + 防撞号窗口（更快命中健康号，但顺序是随机的）。
// 这里关回轮询——本脚本要验的是限流分类与冷却，不是选号分布；顺序随机化会让
// 「901 应进软冷却」这类断言时灵时不灵。
process.env.DUMATE_POOL_PICK_MODE = 'rr';
process.env.DUMATE_POOL_PICK_GAP_MS = '0';

const { classify, isThrottle, throttleRetryMs, QUEUE_THROTTLE_COOLDOWN_MS, isDeterministic } = require('../src/upstream-errors');
const { createPool } = require('../src/pool');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`[PASS] ${label}`); }
  catch (e) { failures++; console.log(`[FAIL] ${label} — ${e.message}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); console.log(`[PASS] ${label}`); }
  catch (e) { failures++; console.log(`[FAIL] ${label} — ${e.message}`); }
}

// 实测抓包原文（内层 JSON 被当字符串塞进信封，引号是转义过的）
const THROTTLE_RESOURCE = 'qoder 403: {"code":"10605","message":"{\\"isQueued\\":true,\\"modelKey\\":\\"dfmodel\\",\\"queueCount\\":0,\\"queueType\\":\\"p3\\",\\"retryAfterSeconds\\":30,\\"serviceAvailable\\":false,\\"subCode\\":\\"RESOURCE_LIMIT\\",\\"waitTime\\":30}","subCode":"RESOURCE_LIMIT"}';
const THROTTLE_CALLCOUNT = 'qoder 403: {"code":"10605","message":"{\\"isQueued\\":true,\\"modelKey\\":\\"dfmodel\\",\\"queueCount\\":2410,\\"queueType\\":\\"p3\\",\\"retryAfterSeconds\\":30,\\"serviceAvailable\\":true,\\"subCode\\":\\"CALL_COUNT_LIMIT\\",\\"waitTime\\":66}","subCode":"CALL_COUNT_LIMIT"}';
// 2026-10-27 实测形态：DeepSeek-Flash 排 4697 位。waitTime 7015 **由冷却
// 时长反推**（pool-state 里 until 比 now 晚 7015 秒；retryAfterSeconds=30
// 只能给出 30000ms，7015000ms 只可能来自 waitTime×1000）。
const THROTTLE_BIGQUEUE = 'qoder 403: {"code":"10605","message":"{\\"isQueued\\":true,\\"modelKey\\":\\"dfmodel\\",\\"queueCount\\":4697,\\"queueType\\":\\"p3\\",\\"retryAfterSeconds\\":30,\\"serviceAvailable\\":true,\\"subCode\\":\\"CALL_COUNT_LIMIT\\",\\"waitTime\\":7015}","subCode":"CALL_COUNT_LIMIT"}';
const READ_IDLE = 'qoder upstream read idle (120000ms)';
const MODEL_GONE = 'qoder 403: {"code":"403","message":"Model is not available for this user"}';
// 2026-10-28 实测形态：**三层**信封。上游把限流信封又包了一层
// （`code:"403"` 里再套 `code:"10605"`），于是内层引号是三倍转义
// （`\\\\"modelKey\\\\"`）。旧判据 `\\?"` 只认零到一层，两个字段全匹配不到：
// 时长取不到（退化 5 分钟基数）、modelKey 认不出（冷却退化成**账号级**，
// 一个模型排队把整条通道封死）。这个向量直接取自 `data/requests.jsonl`
// 对应的真实抓包，不要「整理」成两层——那正是它一直没被覆盖的原因。
const THROTTLE_3LAYER = 'qoder 403: {"code":"403","message":"{\\"code\\":\\"10605\\",\\"message\\":\\"{\\\\\\"isQueued\\\\\\":true,\\\\\\"modelKey\\\\\\":\\\\\\"qfmodel\\\\\\",\\\\\\"queueCount\\\\\\":0,\\\\\\"queueType\\\\\\":\\\\\\"p3\\\\\\",\\\\\\"retryAfterSeconds\\\\\\":30,\\\\\\"serviceAvailable\\\\\\":false,\\\\\\"subCode\\\\\\":\\\\\\"RESOURCE_LIMIT\\\\\\",\\\\\\"waitTime\\\\\\":30}\\",\\"subCode\\":\\"RESOURCE_LIMIT\\"}"}';

console.log('== 1. 限流识别 ==');
check('RESOURCE_LIMIT 认得出', () => assert.ok(isThrottle(THROTTLE_RESOURCE)));
check('CALL_COUNT_LIMIT 认得出', () => assert.ok(isThrottle(THROTTLE_CALLCOUNT)));
check('read idle 认得出（排队挂起的另一种形态）', () => assert.ok(isThrottle(READ_IDLE)));
check('普通模型不可用不是限流', () => assert.ok(!isThrottle(MODEL_GONE)));
check('取 retryAfterSeconds → 30000ms', () => assert.strictEqual(throttleRetryMs(THROTTLE_RESOURCE), 30000));
check('无 retryAfterSeconds 时优先 waitTime → 66000ms', () => assert.strictEqual(throttleRetryMs(THROTTLE_CALLCOUNT), 66000));
check('取不到时长返回 null（不编默认值）', () => assert.strictEqual(throttleRetryMs(READ_IDLE), null));
check('三层信封：retryAfterSeconds 仍取得到（旧判据在这里返回 null）', () => {
  assert.ok(isThrottle(THROTTLE_3LAYER));
  assert.strictEqual(throttleRetryMs(THROTTLE_3LAYER), 30000);
});
check('三层信封：modelKey 认得出 → 冷却按模型级（不封整条通道）', () => {
  const c = classify({ status: 403, message: THROTTLE_3LAYER, model: 'qfmodel' });
  assert.strictEqual(c.kind, 'soft');
  assert.strictEqual(c.scope, 'model');
  // RESOURCE_LIMIT（serviceAvailable:false）是**请求级随机排队**：实测照上游
  // 给的 30 秒等下去并不保证放行（等 10s/30s 连测仍全部 stillThrottled），
  // 而按 30 秒记账会让下一次本来能成的请求在 1~2ms 内被本地拒掉。
  // 所以改用短冷却，**不采信** retryAfterSeconds。
  assert.strictEqual(c.retryAfterMs, QUEUE_THROTTLE_COOLDOWN_MS);
});

console.log('');
console.log('== 2. classify：限流进 soft，不进 breaker ==');
check('403 + RESOURCE_LIMIT → soft 且带短冷却（不采信上游 30s）', () => {
  const c = classify({ status: 403, message: THROTTLE_RESOURCE, model: 'dfmodel' });
  assert.strictEqual(c.kind, 'soft');
  assert.strictEqual(c.retryAfterMs, QUEUE_THROTTLE_COOLDOWN_MS);
});
check('403 + CALL_COUNT_LIMIT → 仍按上游时长冷却（真配额，等久了会恢复）', () => {
  // serviceAvailable:true 的 CALL_COUNT_LIMIT 与排队不同：它是真·调用配额，
  // 上游给的 waitTime(66s) 是可信的，不能一并降级成短冷却。
  const c = classify({ status: 403, message: THROTTLE_CALLCOUNT, model: 'dfmodel' });
  assert.strictEqual(c.kind, 'soft');
  assert.strictEqual(c.retryAfterMs, 66000);
});
check('502 + RESOURCE_LIMIT → soft（状态码不改变判据）', () => {
  assert.strictEqual(classify({ status: 502, message: THROTTLE_RESOURCE, model: 'dfmodel' }).kind, 'soft');
});
check('status=0 + read idle → soft', () => {
  assert.strictEqual(classify({ status: 0, message: READ_IDLE }).kind, 'soft');
});
check('排队挂起用短冷却（5s），不套 5 分钟基数', () => {
  // 上游没给时长时，read idle / queued 都是「这一条被排掉了」，与账号健康无关
  for (const m of [READ_IDLE, 'qoder upstream queued (no content in 30000ms)']) {
    const c = classify({ status: 0, message: m });
    assert.strictEqual(c.kind, 'soft');
    assert.strictEqual(c.retryAfterMs, 5000, m);
  }
});
check('403 模型不可用仍然是 model（没被限流规则吃掉）', () => {
  assert.strictEqual(classify({ status: 403, message: MODEL_GONE, model: 'dfmodel' }).kind, 'model');
});
check('纯 403（既非限流也非模型）仍是 breaker', () => {
  assert.strictEqual(classify({ status: 403, message: 'qoder 403: forbidden' }).kind, 'breaker');
});
check('402 仍是 hard', () => {
  assert.strictEqual(classify({ status: 402, message: 'insufficient balance' }).kind, 'hard');
});
check('限流信号在 200 字之后也能识别（用完整串判）', () => {
  const long = 'qoder 403: ' + 'x'.repeat(220) + ' {"subCode":"RESOURCE_LIMIT","retryAfterSeconds":30}';
  assert.strictEqual(classify({ status: 403, message: long }).kind, 'soft');
  assert.strictEqual(classify({ status: 403, message: long }).retryAfterMs, 30000);
});

console.log('');
console.log('== 3. 池：限流不再放大成 30 分钟封禁 ==');
check('连续 3 次限流（无模型信息）→ 软冷却 30s（不是 30min 熔断）', () => {
  let now = 1_000_000;
  const pool = createPool({ file: null, now: () => now });
  // 不带 model：池拿不到 (账号,模型) 二元组，只能退回账号级冷却
  const cls = classify({ status: 403, message: THROTTLE_RESOURCE });
  for (let i = 0; i < 3; i++) pool.noteError('qoder:1', cls);
  const st = pool.status('qoder:1');
  assert.strictEqual(st.cool_kind, 'soft', '应为软冷却，实际 ' + st.cool_kind);
  assert.strictEqual(st.breaker_fails, 0);
  assert.ok(st.cool_remaining_s <= 30, '冷却应 ≤30s，实际 ' + st.cool_remaining_s);
});
check('上游说的重试时刻到了就能重新选号', () => {
  let now = 1_000_000;
  const pool = createPool({ file: null, now: () => now });
  const cls = classify({ status: 403, message: THROTTLE_RESOURCE });
  pool.noteError('qoder:1', cls);
  assert.strictEqual(pool.pick(['qoder:1'], {}), null, '冷却中不该被选中');
  now += 30_000;
  assert.strictEqual(pool.pick(['qoder:1'], {}), 'qoder:1', '30s 后应恢复');
});
check('没有 retryAfterMs 时才回落基数（5 分钟）', () => {
  let now = 1_000_000;
  const pool = createPool({ file: null, now: () => now });
  pool.noteError('qoder:1', classify({ status: 429, message: 'too many requests' }));
  const st = pool.status('qoder:1');
  assert.strictEqual(st.cool_kind, 'soft');
  assert.ok(st.cool_remaining_s >= 290, '应回落到 5 分钟基数，实际 ' + st.cool_remaining_s);
});
check('冷却中再次限流不延长（防堆厚）', () => {
  let now = 1_000_000;
  const pool = createPool({ file: null, now: () => now });
  // 用 CALL_COUNT_LIMIT（按上游 66s 冷却）：时长够长，才测得出「不叠加」。
  // RESOURCE_LIMIT 现在只给 5s 短冷却，`now += 5s` 正好让它过期，
  // 续期是池的既有语义（守卫条件是 `until > now`），不是叠加。
  const cls = classify({ status: 403, message: THROTTLE_CALLCOUNT });
  pool.noteError('qoder:1', cls);
  const until1 = pool.status('qoder:1').until;
  now += 5_000;
  pool.noteError('qoder:1', cls);
  assert.strictEqual(pool.status('qoder:1').until, until1, '冷却时长不该被叠加');
});
check('异常的 retryAfterMs 被夹进 [1s, 封顶]', () => {
  let now = 1_000_000;
  const pool = createPool({ file: null, now: () => now });
  pool.noteError('a:1', { kind: 'soft', message: 'x', retryAfterMs: 1 });     // 太小
  assert.ok(pool.status('a:1').cool_remaining_s >= 1);
  const pool2 = createPool({ file: null, now: () => now });
  pool2.noteError('a:1', { kind: 'soft', message: 'x', retryAfterMs: 99 * 3600 * 1000 }); // 太大
  assert.ok(pool2.status('a:1').cool_remaining_s <= 2 * 3600, '应被 softMaxMs 封顶');
});

console.log('');
console.log('== 3b. 排队是 (账号, 模型) 粒度：不封整条通道 ==');
// 2026-10-27 用户报「Qoder 整条通道用不了、网页版却正常」的直接原因：
// dfmodel 排 4697 位 → 账号级软冷却 7015 秒 → **同一账号的 qfmodel**
// （上游直接 200）也被本地拒掉，客户端每次重试都在 4ms 内拿到 429。
check('排队信号带 modelKey → classify 标 scope=model', () => {
  const c = classify({ status: 403, message: THROTTLE_CALLCOUNT, model: 'dfmodel' });
  assert.strictEqual(c.kind, 'soft');
  assert.strictEqual(c.scope, 'model');
  assert.strictEqual(c.model, 'dfmodel');
});
check('不带 model 时退回账号级（池无法按模型隔离）', () => {
  const c = classify({ status: 403, message: THROTTLE_CALLCOUNT });
  assert.strictEqual(c.kind, 'soft');
  assert.strictEqual(c.scope, undefined);
});
check('dfmodel 排队不封账号：qfmodel 仍可选', () => {
  let now = 1_000_000;
  const pool = createPool({ file: null, now: () => now });
  pool.noteError('qoder:1', classify({ status: 403, message: THROTTLE_CALLCOUNT, model: 'dfmodel' }));
  const st = pool.status('qoder:1');
  assert.strictEqual(st.cool_kind, '', '账号本身不该被冷却，实际 ' + st.cool_kind);
  assert.ok((st.model_cooldowns || []).some((m) => m.model === 'dfmodel'), 'dfmodel 应进模型级冷却');
  assert.strictEqual(pool.pick(['qoder:1'], { model: 'dfmodel' }), null, '排队的模型应被跳过');
  assert.strictEqual(pool.pick(['qoder:1'], { model: 'qfmodel' }), 'qoder:1', '别的模型仍可用');
});
check('排队时长被 THROTTLE_MAX_MS 封顶（7015 秒 → 10 分钟）', () => {
  const c = classify({ status: 403, message: THROTTLE_BIGQUEUE, model: 'dfmodel' });
  assert.strictEqual(c.kind, 'soft');
  assert.ok(c.retryAfterMs <= 600000, '应封顶 600000ms，实际 ' + c.retryAfterMs);
  let now = 1_000_000;
  const pool = createPool({ file: null, now: () => now });
  pool.noteError('qoder:1', c);
  const mc = pool.status('qoder:1').model_cooldowns.find((m) => m.model === 'dfmodel');
  assert.ok(mc, '应有 dfmodel 的模型级冷却');
  assert.ok(mc.until - now <= 600000, '模型级冷却也该封顶，实际 ' + (mc.until - now));
});
check('账号健康、仅模型排队 → availability 报 softOnly（下游 429 而不是 503）', () => {
  const channelPoolLocal = require('../src/channel-pool');
  // channel-pool 用的是单例池（已重定向到临时文件），直接在单例上造状态
  const { pool: single } = require('../src/pool');
  single.noteError('qoder:901', classify({ status: 403, message: THROTTLE_CALLCOUNT, model: 'dfmodel' }));
  const av = channelPoolLocal.availability('qoder', [{ id: 901 }], { model: 'dfmodel' });
  assert.strictEqual(av.usable, false);
  assert.strictEqual(av.softOnly, true, '模型排队属于「稍后再来」，不是通道故障');
  assert.ok(av.nextInMs > 0, '应给出重试时刻');
  single.revive('qoder:901');
});

console.log('');
console.log('== 3c. 额度类业务码 112/110/430/114（2026-10-30 对齐 qoder2api-hub #108）==');
// 信封原文取自 hub #108 的现场日志：HTTP 403 + {"code":"112","message":"{\"pricingUrl\":...}"}
// 这些码 < 400，payloadError 不认，由 qoder/index.js 通道层识别。
const qoderIndex = require('../src/qoder/index');
const errtext = require('../src/errtext');
const D112 = 'qoder 403: {"code":"112","message":"{\\"pricingUrl\\":\\"https://qoder.com.cn/pricing?client=qoder\\"}"}';
const D110 = 'qoder 403: {"code":"110","message":"Billing daily count exceeded"}';
const D430 = 'qoder 403: {"code":"430","message":"please upgrade client"}';
check('112 认得出（信封转义形态，code 藏在 message 深处）', () => {
  assert.strictEqual(qoderIndex.quotaKindOfText(D112), 'exhausted');
});
check('110 认得出（code 与文案两种锚都认）', () => {
  assert.strictEqual(qoderIndex.quotaKindOfText(D110), 'daily');
  assert.strictEqual(qoderIndex.quotaKindOfText('x {"code":"110"} y'), 'daily');
});
check('114 / 430 认得出', () => {
  assert.strictEqual(qoderIndex.quotaKindOfText('{"code":"114","message":"trial limited"}'), 'trial');
  assert.strictEqual(qoderIndex.quotaKindOfText(D430), 'version');
});
check('10605 排队不误判成额度', () => {
  assert.strictEqual(qoderIndex.quotaKindOfText(THROTTLE_RESOURCE), '');
  assert.strictEqual(qoderIndex.quotaKindOfText(THROTTLE_3LAYER), '');
});
check('普通 403 / 模型不可用不误判成额度', () => {
  assert.strictEqual(qoderIndex.quotaKindOfText(MODEL_GONE), '');
  assert.strictEqual(qoderIndex.quotaKindOfText('qoder 403: forbidden'), '');
});
check('额度帧逐帧识别：顶层 code 才算数（模型正文里讨论 112 不误伤）', () => {
  const fe = qoderIndex.quotaFrameError({ code: '112', message: '{"pricingUrl":"x"}' });
  assert.strictEqual(fe.code, 403);
  assert.strictEqual(fe.quotaKind, 'exhausted');
  assert.strictEqual(qoderIndex.quotaFrameError({ choices: [{ delta: { content: '{"code":"112"}' } }] }), null);
  assert.strictEqual(qoderIndex.quotaFrameError({ code: '10605' }), null);
});
check('quotaFromBody 从 SSE 行 / 裸 JSON 里找额度帧', () => {
  assert.ok(qoderIndex.quotaFromBody('data: {"code":"112","message":"x"}\n\n'));
  assert.ok(qoderIndex.quotaFromBody('{"code":"110","message":"Billing daily count exceeded"}'));
  assert.strictEqual(qoderIndex.quotaFromBody('data: {"choices":[{"delta":{"content":"{\\"code\\":\\"112\\"}"}}]}'), null);
});
check('112/110/114 可换号（别的账号可能还有额度）', () => {
  assert.strictEqual(qoderIndex.retryable(403, D112), true);
  assert.strictEqual(qoderIndex.retryable(403, D110), true);
  assert.strictEqual(qoderIndex.retryable(403, '{"code":"114"}'), true);
});
check('430 版本门不换号（每个号都会 430，快速失败）', () => {
  assert.strictEqual(qoderIndex.retryable(403, D430), false);
});
check('112 喂池 = 429 + 30 分钟固定冷却', () => {
  const info = qoderIndex.poolInfoOf({ statusCode: 403, message: D112 }, 'gfmodel');
  assert.strictEqual(info.status, 429);
  assert.ok(Math.abs(info.retryAfterMs - 30 * 60 * 1000) < 1000, '实际 ' + info.retryAfterMs);
});
check('110 喂池 = 429 + 到下一个本地 0 点', () => {
  const info = qoderIndex.poolInfoOf({ statusCode: 403, message: D110 }, 'gfmodel');
  assert.strictEqual(info.status, 429);
  assert.ok(info.retryAfterMs > 0 && info.retryAfterMs <= 24 * 3600 * 1000, '实际 ' + info.retryAfterMs);
});
check('430 喂池 = 400（请求/网关版本问题，不惩罚账号）', () => {
  const info = qoderIndex.poolInfoOf({ statusCode: 403, message: D430 }, 'gfmodel');
  assert.strictEqual(info.status, 400);
});
check('额度类经 classify 是 soft（不进熔断/不禁用），且 10605 判据不受影响', () => {
  assert.strictEqual(classify(qoderIndex.poolInfoOf({ statusCode: 403, message: D112 }, 'gfmodel')).kind, 'soft');
  assert.strictEqual(classify({ status: 403, message: D112 }).kind, 'breaker', '裸 403 + 112 不带钉时长时仍按旧路（调用方必须走 poolInfoOf）');
});
check('classify 透传调用方钉的 retryAfterMs（通用能力，不认识业务码）', () => {
  const c = classify({ status: 429, message: 'quota', retryAfterMs: 1800000 });
  assert.strictEqual(c.kind, 'soft');
  assert.strictEqual(c.retryAfterMs, 1800000);
});
check('池：112 的 30 分钟冷却生效、soft_streak 不递增、不写模型级冷却', () => {
  let now = 5_000_000;
  const pool = createPool({ file: null, now: () => now });
  pool.noteError('qoder:q1', classify(qoderIndex.poolInfoOf({ statusCode: 403, message: D112 }, 'gfmodel')));
  const st = pool.status('qoder:q1');
  assert.strictEqual(st.cool_kind, 'soft');
  assert.ok(Math.abs(st.cool_remaining_s - 1800) <= 2, '实际 ' + st.cool_remaining_s + 's');
  assert.strictEqual(st.soft_streak, 0, '显式时长不算「又超速一次」');
  assert.strictEqual(st.model_cooldowns.length, 0, '配额是账号级的，不写模型冷却');
  // 冷却中再失败不延长（防越堆越厚）
  now += 60_000;
  pool.noteError('qoder:q1', classify(qoderIndex.poolInfoOf({ statusCode: 403, message: D112 }, 'gfmodel')));
  const st2 = pool.status('qoder:q1');
  assert.ok(Math.abs(st2.cool_remaining_s - 1740) <= 2, '冷却中不得重置，实际 ' + st2.cool_remaining_s + 's');
});
check('errtext：112/110/430 翻译成人话（含多层转义形态），普通 403 不误翻', () => {
  assert.ok(errtext.explainError(D112).includes('额度已耗尽'));
  assert.ok(errtext.explainError(D110).includes('当日调用次数'));
  assert.ok(errtext.explainError(D430).includes('版本过低'));
  // 逐层转义：内层 code 被当字符串再包一层信封（\\\\"code\\\\":\\\\"112\\\\"）
  assert.ok(errtext.explainError('qoder 403: {"code":"403","message":"{\\\\\\"code\\\\\\":\\\\\\"112\\\\\\",\\\\\\"message\\\\\\":\\\\\\"{\\\\\\\\\\\\\\"pricingUrl\\\\\\\\\\\\\\":1}\\\\\\"}"}').includes('额度已耗尽'));
  assert.ok(!errtext.explainError(MODEL_GONE).includes('额度'), MODEL_GONE);
});

console.log('');
console.log('== 3d. FEFO（最早到期优先）：pool 的 expiring 过滤（临期积分先烧掉）==');
check('expiring 非空时候选被限制在集合内（无论游标位置）', () => {
  const pool = createPool({ file: null });
  for (let i = 0; i < 4; i++) {
    assert.strictEqual(
      pool.pick(['qoder:e1', 'qoder:e2'], { expiring: new Set(['qoder:e1']) }),
      'qoder:e1',
    );
  }
});
check('临期号不健康（软冷却）时退回全量候选，不因 FEFO 卡死', () => {
  const pool = createPool({ file: null });
  pool.noteError('qoder:e1', { kind: 'soft', status: 429, message: 'x', retryAfterMs: 60000 });
  assert.strictEqual(pool.pick(['qoder:e1', 'qoder:e2'], { expiring: new Set(['qoder:e1']) }), 'qoder:e2');
});
check('expiring 为空/null 时无感（普通选号）', () => {
  const pool = createPool({ file: null });
  assert.ok(pool.pick(['qoder:e1', 'qoder:e2'], { expiring: null }));
  assert.ok(pool.pick(['qoder:e1', 'qoder:e2'], {}));
});

console.log('');
console.log('== 4. 通道层：换号 + 下游拿到 429 ==');

// 池单例已在 DUMATE_POOL_STATE 的临时文件上，不会碰真实 data/
const authStore = require('../src/qoder/auth');
const session = require('../src/qoder/session');
const chat = require('../src/qoder/chat');
const credits = require('../src/qoder/credits');
const channelPool = require('../src/channel-pool');

const ACCOUNTS = [
  { id: 901, nickname: 'acct-a', region: 'cn', uid: 'ua', accessToken: 'ta', refreshToken: 'ra', enabled: true, preferred: true },
  { id: 902, nickname: 'acct-b', region: 'cn', uid: 'ub', accessToken: 'tb', refreshToken: 'rb', enabled: true, preferred: false },
];
const MODELS = [{ key: 'gfmodel', name: 'GLM-5.3-Flash', maxInputTokens: 100000 }];

authStore.findUsable = () => ACCOUNTS;
authStore.preferred = () => ACCOUNTS[0];
authStore.patch = () => true;               // 不写真实账号文件
session.ensureAccount = async (store, acc) => acc;
session.cachedModels = () => MODELS;
session.fetchModels = async () => ({ ok: true, error: '', models: MODELS });
credits.capture = () => {};                 // 不写真实积分账本

/** 让 postStream 按「当前账号的 accessToken → 剧本」返回：'throttle' | 'readidle' | 'ok'
 *  剧本可以是数组，按该账号的第 N 次调用依次取（用于验证「重试同一账号」）。 */
let scripts = {};
let currentToken = '';
let callsByToken = {};
chat.postStream = async (url, body, headers, onChunk) => {
  const n = (callsByToken[currentToken] = (callsByToken[currentToken] || 0) + 1);
  let plan = scripts[currentToken] || 'ok';
  if (Array.isArray(plan)) plan = plan[n - 1] || plan[plan.length - 1] || 'ok';
  if (plan === 'throttle') {
    const err = new Error(THROTTLE_RESOURCE);
    err.statusCode = 403;
    throw err;
  }
  if (plan === 'readidle') {
    const err = new Error(READ_IDLE);
    err.statusCode = 0;
    throw err;
  }
  if (plan === 'neterr') {
    const err = new Error('getaddrinfo ENOTFOUND gateway.qoder.com.cn');
    err.statusCode = 0;
    throw err;
  }
  if (plan === 'quota112') {
    const err = new Error(D112);
    err.statusCode = 403;
    throw err;
  }
  if (plan === 'quota112frame') {
    // 200 + 流内 112 错误帧（payloadError 不认 <400 的码，走 quotaFrameError）
    onChunk(JSON.stringify({ code: '112', message: '{"pricingUrl":"https://qoder.com.cn/pricing?client=qoder"}' }));
    return { status: 200, headers: {}, raw: '' };
  }
  if (plan === 'quota430') {
    const err = new Error(D430);
    err.statusCode = 403;
    throw err;
  }
  onChunk(JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: null }] }));
  onChunk(JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { credits: 0.1 } }));
  onChunk('[DONE]');
  return { status: 200, headers: {}, raw: '' };
};

function resetCase(plan) {
  channelPool._stickyClear();
  callsByToken = {};
  scripts = plan;
}

(async () => {
  // runOnce 内部会经 ensureAccount 取账号——用 accessToken 标记「这一轮是谁」
  session.ensureAccount = async (store, acc) => { currentToken = acc.accessToken; return acc; };

  const payload = { model: 'gfmodel', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };

  await checkAsync('账号 A 被限流 → 自动换到 B 并成功', async () => {
    channelPool._stickyClear();
    scripts = { ta: 'throttle', tb: 'ok' };
    const chunks = [];
    const r = await require('../src/qoder').send(payload, (c) => chunks.push(c), { sessionKey: 'case-a' });
    assert.strictEqual(r.status, 200);
    assert.ok(chunks.some((c) => c.includes('pong')), '应从 B 拿到正文');
    // A 的 gfmodel 进模型级冷却（账号本身不封——排队是 (账号,模型) 粒度），B 健康
    const stA = require('../src/pool').pool.status('qoder:901');
    assert.ok((stA.model_cooldowns || []).some((m) => m.model === 'gfmodel'), 'A 的 gfmodel 应进模型级冷却');
    assert.strictEqual(stA.cool_kind, '', '账号本身不该被冷却，实际 ' + stA.cool_kind);
    require('../src/pool').pool.revive('qoder:901');
  });

  await checkAsync('两个账号都被限流 → 下游 429（不是 403/502）', async () => {
    channelPool._stickyClear();
    scripts = { ta: 'throttle', tb: 'throttle' };
    let err = null;
    try { await require('../src/qoder').send(payload, () => {}, { sessionKey: 'case-b' }); }
    catch (e) { err = e; }
    assert.ok(err, '应该抛错');
    assert.strictEqual(err.statusCode, 429, '实际 ' + err.statusCode + ' / ' + err.message);
    assert.ok(err.throttled === true);
    require('../src/pool').pool.revive('qoder:901');
    require('../src/pool').pool.revive('qoder:902');
  });

  await checkAsync('限流轮询中夹进网络错误 → 仍回 429（不退化成 502）', async () => {
    // 实测 2026-10-28：5 次 403 排队 + 1 次 DNS 失败（ENOTFOUND），旧判据
    // 只认限流，聚合状态码退化成 502——客户端当硬失败不再重试。
    // 网络错误与排队同为瞬时类（retryable 对 code=0 也放行换号），聚合
    // 口径应与轮询继续的 transientOnly 一致。
    channelPool._stickyClear();
    scripts = { ta: 'throttle', tb: 'neterr' };
    let err = null;
    try { await require('../src/qoder').send(payload, () => {}, { sessionKey: 'case-b2' }); }
    catch (e) { err = e; }
    assert.ok(err, '应该抛错');
    assert.strictEqual(err.statusCode, 429, '实际 ' + err.statusCode + ' / ' + err.message);
    assert.ok(err.throttled === true);
    require('../src/pool').pool.revive('qoder:901');
    require('../src/pool').pool.revive('qoder:902');
  });

  // rr 游标是池内单调的，用例不假设起手账号：轮转最多两轮（各自起手一次），
  // A 起手的那轮做断言。B 起手的轮也顺带验证了「健康号直接成功」。
  async function untilAFirst(name, runCase) {
    let sawSwitch = false;
    for (let i = 0; i < 2 && !sawSwitch; i++) {
      channelPool._stickyClear();
      require('../src/pool').pool.revive('qoder:901');
      require('../src/pool').pool.revive('qoder:902');
      const before = { ta: callsByToken.ta || 0, tb: callsByToken.tb || 0 };
      await runCase(i, before, () => {
        sawSwitch = true;
      });
    }
    assert.ok(sawSwitch, `${name}：两轮轮转应有一次以 A 起手`);
    require('../src/pool').pool.revive('qoder:901');
    require('../src/pool').pool.revive('qoder:902');
  }

  await checkAsync('额度耗尽(112) → 换号成功，命中账号进 30 分钟账号级软冷却', async () => {
    await untilAFirst('112 换号', async (i, before, hitA) => {
      scripts = { ta: 'quota112', tb: 'ok' };
      const chunks = [];
      const r = await require('../src/qoder').send(payload, (c) => chunks.push(c), { sessionKey: `case-q1-${i}` });
      assert.strictEqual(r.status, 200);
      assert.ok(chunks.some((c) => c.includes('pong')), '应从健康账号拿到正文');
      if ((callsByToken.ta || 0) - before.ta === 0) return; // B 起手：健康号直接成功，下一轮再验
      hitA();
      const stA = require('../src/pool').pool.status('qoder:901');
      assert.strictEqual(stA.cool_kind, 'soft', '额度耗尽是账号级软冷却，实际 ' + stA.cool_kind);
      assert.ok(stA.cool_remaining_s > 1700, '应接近 30 分钟，实际 ' + stA.cool_remaining_s + 's');
      assert.strictEqual(stA.model_cooldowns.length, 0, '配额不写模型级冷却');
      assert.strictEqual(stA.state, 'cooling', '不是 disabled');
    });
  });

  await checkAsync('流内 112 错误帧（200 信封）→ 识别并换号，不再空回答', async () => {
    await untilAFirst('112 帧', async (i, before, hitA) => {
      scripts = { ta: 'quota112frame', tb: 'ok' };
      const chunks = [];
      const r = await require('../src/qoder').send(payload, (c) => chunks.push(c), { sessionKey: `case-q2-${i}` });
      assert.strictEqual(r.status, 200);
      assert.ok(chunks.some((c) => c.includes('pong')), '应从健康账号拿到正文');
      if ((callsByToken.ta || 0) - before.ta === 0) return;
      hitA();
      const stA = require('../src/pool').pool.status('qoder:901');
      assert.strictEqual(stA.cool_kind, 'soft');
    });
  });

  await checkAsync('两账号都额度耗尽 → 下游拿 403（不伪装成 429），文案点明额度', async () => {
    channelPool._stickyClear();
    scripts = { ta: 'quota112', tb: 'quota112' };
    let err = null;
    try { await require('../src/qoder').send(payload, () => {}, { sessionKey: 'case-q3' }); }
    catch (e) { err = e; }
    assert.ok(err, '应该抛错');
    assert.strictEqual(err.statusCode, 403, '额度耗尽不是瞬时故障，不该伪装成 429，实际 ' + err.statusCode);
    assert.ok(errtext.explainError(err.message).includes('额度已耗尽'), err.message);
    require('../src/pool').pool.revive('qoder:901');
    require('../src/pool').pool.revive('qoder:902');
  });

  await checkAsync('版本门 430 → 快速失败不换号，账号不进冷却', async () => {
    await untilAFirst('430 版本门', async (i, before, hitA) => {
      scripts = { ta: 'quota430', tb: 'ok' };
      let err = null;
      try { await require('../src/qoder').send(payload, () => {}, { sessionKey: `case-q4-${i}` }); }
      catch (e) { err = e; }
      if (!err) return; // B 起手：健康号直接成功，下一轮再验
      assert.ok(err.message.includes('430'), err.message);
      hitA();
      const stA = require('../src/pool').pool.status('qoder:901');
      assert.strictEqual(stA.cool_kind, '', '430 是网关版本问题，不该罚账号');
    });
  });

  await checkAsync('两账号都在限流冷却里 → 立刻回 429 而不是 503', async () => {
    channelPool._stickyClear();
    // 剧本显式声明：本用例等待冷却后真发请求（入口会把 5s 冷却等掉），
    // 不能依赖前序用例残留的 scripts。
    resetCase({ ta: 'throttle', tb: 'throttle' });
    const { pool } = require('../src/pool');
    const cls = classify({ status: 403, message: THROTTLE_RESOURCE });
    pool.noteError('qoder:901', cls);
    pool.noteError('qoder:902', cls);
    let err = null;
    try { await require('../src/qoder').send(payload, () => {}, { sessionKey: 'case-c' }); }
    catch (e) { err = e; }
    assert.ok(err, '应该抛错');
    assert.strictEqual(err.statusCode, 429, '实际 ' + err.statusCode + ' / ' + err.message);
    assert.ok(/限流/.test(err.message), '错误文案应说明是限流：' + err.message);
    pool.revive('qoder:901');
    pool.revive('qoder:902');
  });

  await checkAsync('读空闲（排队挂起）也换号并成功', async () => {
    channelPool._stickyClear();
    // **两个账号首调都必须失败**：pool.pick 是轮询游标，先选中谁由前面
    // 用例消耗的次数决定（2026-10-30 教训：只给 ta 设失败剧本，游标停在
    // 902 时 901 根本不会被调用，用例就变成了「直接成功」的空转）。
    // 两账号 [readidle, ok] 保证「失败→换号→重试成功」路径必然发生，
    // 且失败者（两个都会失败一次）进 soft 而非熔断。
    resetCase({ ta: ['readidle', 'ok'], tb: ['readidle', 'ok'] });
    const r = await require('../src/qoder').send(payload, () => {}, { sessionKey: 'case-d' });
    assert.strictEqual(r.status, 200);
    const { pool } = require('../src/pool');
    const stA = pool.status('qoder:901');
    const stB = pool.status('qoder:902');
    assert.strictEqual(stA.cool_kind, 'soft', 'read idle 应进软冷却');
    assert.strictEqual(stB.cool_kind, 'soft', '两个账号都经历过一次 readidle 失败');
    assert.strictEqual(stA.breaker_fails, 0, 'read idle 不该累计熔断');
    pool.revive('qoder:901');
    pool.revive('qoder:902');
  });

  await checkAsync('排队挂起后快速重试同一账号 → 成功（不在网关里干等冷却）', async () => {
    // 2026-10-29 实测推翻了「等掉冷却再重试」的旧结论：
    //   · 排队是**请求级随机**，照上游 retryAfterSeconds 等 30 秒并不保证放行
    //     （等 10s / 30s 连测仍全部 stillThrottled）
    //   · 而在网关里等，全部累加到用户感知上（实测首条请求因此耗到 27~35 秒）
    // 新策略：**快速轮询几轮就交还客户端**。本用例锁定「挂起后仍能很快成功」，
    // 且总耗时必须远小于旧的「等 5 秒冷却」路径。
    resetCase({ ta: ['readidle', 'ok'], tb: ['readidle'] });
    const t0 = Date.now();
    const r = await require('../src/qoder').send(payload, () => {}, { sessionKey: 'case-e' });
    const spent = Date.now() - t0;
    assert.strictEqual(r.status, 200);
    assert.ok(spent < 4000, '应快速轮询命中，而不是干等冷却，实际 ' + spent + 'ms');
    const { pool } = require('../src/pool');
    pool.revive('qoder:901');
    pool.revive('qoder:902');
  });

  // ── 5. 确定性 vs 瞬时 ────────────────────────────────────────────────
  // 「重发同一份字节必然得到同一个失败」的错误不该让客户端重试，也不该让网关
  // 在换号前白等；反过来，限流是瞬时的，**绝不能**被判成确定性——否则客户端
  // 不再退避重试，用户看到的就是「点了没反应」（这正是上游条件明明写着
  // retryAfterSeconds 却没人去等的那类故障）。
  check('413 / 404 / 400 / 422 判为确定性', () => {
    for (const s of [400, 404, 413, 415, 422]) {
      assert.strictEqual(isDeterministic(s, 'something'), true, `status ${s} 应判确定性`);
    }
  });

  check('「模型不在套餐」文案判为确定性（哪怕状态码是 403）', () => {
    assert.strictEqual(isDeterministic(403, 'Model is not available for this user'), true);
    assert.strictEqual(isDeterministic(403, 'model not found'), true);
  });

  check('请求体过大判为确定性', () => {
    assert.strictEqual(isDeterministic(0, 'Payload Too Large'), true);
  });

  check('限流**不能**被判成确定性（哪怕是 403 信封形态）', () => {
    assert.strictEqual(isDeterministic(403, THROTTLE_RESOURCE), false, 'RESOURCE_LIMIT 被误判成确定性');
    assert.strictEqual(isDeterministic(403, THROTTLE_CALLCOUNT), false, '排队被误判成确定性');
    assert.strictEqual(isDeterministic(429, 'rate limited'), false, '429 被误判成确定性');
  });

  check('网络层失败与 5xx 不算确定性（瞬时，换号/重试有意义）', () => {
    assert.strictEqual(isDeterministic(0, 'ECONNRESET'), false);
    assert.strictEqual(isDeterministic(500, 'internal error'), false);
    assert.strictEqual(isDeterministic(502, 'bad gateway'), false);
  });

  check('classify 输出带 deterministic 标志', () => {
    assert.strictEqual(classify({ status: 413, message: 'big' }).deterministic, true);
    assert.strictEqual(classify({ status: 403, message: THROTTLE_RESOURCE }).deterministic, false);
    assert.strictEqual(classify(null).deterministic, false, 'null 输入不该抛错');
  });

  session.ensureAccount = async (store, acc) => acc;

  // 清理临时池文件
  try { require('../src/pool').pool.close(); } catch (e) { /* 忽略 */ }
  try { fs.unlinkSync(TMP_STATE); } catch (e) { /* 不存在 */ }

  console.log('');
  if (failures) { console.log(`✗ ${failures} 项失败`); process.exit(1); }
  console.log('✓ 全部通过');
})();
