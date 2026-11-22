// test/unit/route-groups.test.js - 自定义路由组（P1-7 第一批）离线验证
//
// 这批只做「分发前按可用性择优」：组名显式命中 → 逐个成员查 availability →
// 第一个可用的胜出；全都不可用回 503（**不是 400**，那是暂时性故障）。
//
// 判据（按重要性排）：
//   1. 组名必须显式命中，**绝不猜**；未命中时行为与没有本功能逐字节一致
//   2. 配置坏掉的形态**逐条丢弃并给出原因**（重名/带斜杠/空成员/成环/超限）
//   3. 择优要记下跳过了谁、为什么——不然「为什么走了第二条通道」无从回答
//   4. 全不可用 → errorStatus 503 + 逐条原因（不是一句笼统的「不可用」）
//
// 运行：node --test test/unit/route-groups.test.js
const assert = require('assert');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-groups-'));
process.env.DUMATE_ADMIN_DATA = TMP;

const groups = require('../../src/route-groups');
const router = require('../../src/upstream-router');

function write(cfg) {
  fs.writeFileSync(path.join(TMP, groups.FILE), JSON.stringify(cfg), 'utf8');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(TMP, groups.FILE), later, later);   // 推远 mtime，绕开同毫秒缓存
  groups._resetForTest();
}

function clearFile() {
  try { fs.rmSync(path.join(TMP, groups.FILE), { force: true }); } catch (e) { /* 没有就算 */ }
  groups._resetForTest();
}

const ok = (ch) => ({ ok: true });
const no = (why) => ({ ok: false, reason: why });

test('sanitize：合法组保留，坏形态逐条丢弃并说明原因', () => {
  const { groups: list, dropped } = groups.sanitize({
    groups: [
      { name: 'fast', members: ['qwen/pro', 'traework/glm-5.2'] },
      { name: 'a/b', members: ['glm-5'] },              // 带斜杠
      { name: 'empty', members: [] },                    // 空成员
      { name: 'fast', members: ['glm-5'] },              // 重名
      { name: 'loop', members: ['loop'] },               // 自环
      { name: '', members: ['glm-5'] },                  // 缺 name
      'junk',                                            // 非对象
    ],
  });
  assert.deepStrictEqual(list.map((g) => g.name), ['fast']);
  assert.deepStrictEqual(list[0].members, ['qwen/pro', 'traework/glm-5.2']);
  const whys = dropped.map((d) => `${d.name}:${d.why}`).join(' | ');
  assert.match(whys, /a\/b:组名不能含斜杠/);
  assert.match(whys, /empty:members 为空/);
  assert.match(whys, /fast:重名/);
  assert.match(whys, /loop:成员「loop」也是一个组名/);
  assert.match(whys, /缺少 name/);
});

test('sanitize：成员是**别的**组名时只丢引用方（断开环就够了，别株连无辜）', () => {
  const { groups: list, dropped } = groups.sanitize([
    { name: 'a', members: ['b'] },      // a 引用了组名 b → 丢 a
    { name: 'b', members: ['glm-5'] },  // b 本身合法，保留
  ]);
  assert.deepStrictEqual(list.map((g) => g.name), ['b']);
  assert.strictEqual(dropped.length, 1);
  assert.match(dropped[0].why, /也是一个组名/);
});

test('sanitize：接受裸数组；去重成员；超过上限丢弃', () => {
  const bare = groups.sanitize([{ name: 'x', members: ['a', 'a', 'b'] }]);
  assert.deepStrictEqual(bare.groups[0].members, ['a', 'b']);
  const many = groups.sanitize([{ name: 'big', members: Array.from({ length: groups.MAX_MEMBERS + 1 }, (_, i) => `m${i}`) }]);
  assert.strictEqual(many.groups.length, 0);
  assert.match(many.dropped[0].why, /超过 20 个/);
});

test('Load：无文件 = 没有组；坏 JSON 不抛，按没有组处理', () => {
  clearFile();
  assert.deepStrictEqual(groups.Load().groups, []);
  fs.writeFileSync(path.join(TMP, groups.FILE), '{ 这不是 json', 'utf8');
  groups._resetForTest();
  assert.deepStrictEqual(groups.Load().groups, [], '坏文件不能把路由带下去');
});

test('plan：显式命中才算，大小写敏感，未命中返回 null', () => {
  write({ groups: [{ name: 'fast', members: ['qwen/pro', 'glm-5'] }] });
  assert.deepStrictEqual(groups.plan('fast'), { name: 'fast', members: ['qwen/pro', 'glm-5'] });
  assert.strictEqual(groups.plan('Fast'), null, '模型名一直大小写敏感，组名不例外');
  assert.strictEqual(groups.plan('fast2'), null);
  assert.strictEqual(groups.plan(''), null);
  assert.deepStrictEqual(groups.names(), ['fast']);
});

test('resolveWithGroup：没有组时与 resolve 完全一致（回归锚）', () => {
  clearFile();
  for (const m of ['glm-5', 'qwen/pro', 'qwn/pro', 'dm-auto-model/text.L0']) {
    const a = router.resolveWithGroup(m);
    const b = router.resolve(m);
    assert.deepStrictEqual(
      { channel: a.channel, model: a.model, error: a.error },
      { channel: b.channel, model: b.model, error: b.error },
      `${m} 没有组时不该有任何差异`,
    );
    assert.strictEqual(a.group, undefined);
  }
});

test('resolveWithGroup：首个成员可用就直接用它，group.index=1', () => {
  write({ groups: [{ name: 'fast', members: ['qwen/pro', 'traework/glm-5.2'] }] });
  const r = router.resolveWithGroup('fast', { availability: () => ok() });
  assert.strictEqual(r.channel, 'qwenwork');
  assert.strictEqual(r.model, 'pro');
  assert.strictEqual(r.group.name, 'fast');
  assert.strictEqual(r.group.index, 1);
  assert.strictEqual(r.group.total, 2);
  assert.deepStrictEqual(r.group.skipped, []);
});

test('resolveWithGroup：首个不可用就换下一个，并记下跳过原因', () => {
  write({ groups: [{ name: 'fast', members: ['qwen/pro', 'traework/glm-5.2', 'glm-5'] }] });
  const r = router.resolveWithGroup('fast', {
    availability: (ch) => (ch === 'qwenwork' ? no('没有可用账号（需先登录）') : ok()),
  });
  assert.strictEqual(r.channel, 'traework');
  assert.strictEqual(r.group.index, 2);
  assert.strictEqual(r.group.skipped.length, 1);
  assert.strictEqual(r.group.skipped[0].member, 'qwen/pro');
  assert.match(r.group.skipped[0].reason, /需先登录/);
});

test('resolveWithGroup：成员写错前缀时跳过它而不是整体报错', () => {
  write({ groups: [{ name: 'fast', members: ['qwn/pro', 'glm-5'] }] });
  const r = router.resolveWithGroup('fast', { availability: () => ok() });
  assert.strictEqual(r.channel, 'dumate', '跳过错前缀，落到第二条');
  assert.match(r.group.skipped[0].reason, /unknown_channel/);
});

test('resolveWithGroup：全不可用 → 503 + 逐条原因（不是 400 笼统不可用）', () => {
  write({ groups: [{ name: 'fast', members: ['qwen/pro', 'traework/glm-5.2'] }] });
  const r = router.resolveWithGroup('fast', { availability: () => no('通道未启用') });
  assert.ok(r.error, '要报错');
  assert.strictEqual(r.errorStatus, 503, '暂时性故障：503 而不是 400');
  assert.match(r.error, /route_group_unavailable: fast/);
  assert.match(r.error, /1\.qwen\/pro: 通道未启用/);
  assert.match(r.error, /2\.traework\/glm-5\.2: 通道未启用/, '每条成员都要有原因');
  assert.strictEqual(r.group.index, 0);
});

test('resolveWithGroup：availability 抛错按不可用处理，不把异常抛给请求', () => {
  write({ groups: [{ name: 'fast', members: ['qwen/pro', 'glm-5'] }] });
  let calls = 0;
  const r = router.resolveWithGroup('fast', {
    availability: (ch) => { calls += 1; if (ch === 'qwenwork') throw new Error('boom'); return ok(); },
  });
  assert.strictEqual(calls, 2);
  assert.strictEqual(r.channel, 'dumate');
  assert.match(r.group.skipped[0].reason, /availability 抛错: boom/);
});

test('真实 availability 下（本机零账号）：组会落到 dumate，跳过不了就如实报 503', () => {
  write({ groups: [{ name: 'fast', members: ['qwen/pro', 'dumate-nonexistent-ok'] }] });
  // 不注入 availability：qwenwork 本机没有登录态，必然不可用；第二条落到 dumate，
  // 而 dumate 在 DUMATE_SOURCE=web 且网页池空时也不可用 → 全不可用
  const r = router.resolveWithGroup('fast');
  if (r.error) {
    assert.strictEqual(r.errorStatus, 503);
    assert.match(r.error, /route_group_unavailable/);
  } else {
    assert.strictEqual(r.channel, 'dumate');
    assert.ok(r.group.index >= 1);
  }
});

test('resolveWithGroup：group 里必须带完整 members（运行时换成员要靠它）', () => {
  write({ groups: [{ name: 'fast', members: ['qwen/pro', 'traework/glm-5.2', 'glm-5'] }] });
  const r = router.resolveWithGroup('fast', { availability: () => ok() });
  assert.ok(r.group, '要带 group');
  assert.deepStrictEqual(r.group.members, ['qwen/pro', 'traework/glm-5.2', 'glm-5'],
    'members 必须整份带上——第一批只给了 total，运行时换成员无从往后走（实测踩到：重试静默不生效）');
  assert.strictEqual(r.group.total, 3);
  // 全不可用时同样要带 members（此时 index=0，调用方要知道本来有哪几个）
  const none = router.resolveWithGroup('fast', { availability: () => no('没号') });
  assert.deepStrictEqual(none.group.members, ['qwen/pro', 'traework/glm-5.2', 'glm-5']);
  assert.strictEqual(none.group.index, 0);
});
