// test/unit/duplicated-v1-hint.test.js - 重复 /v1 前缀的带提示 404（P2-24）
//
// 调研出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P2-24「协议杂项补丁包」
// 里的「重复 /v1 前缀带提示的 404」（融合自 qoder2api-hub）。
//
// **为什么值得单独做**：这是接入第一高频错误——base URL 已经带了 `/v1`，
// 客户端又按自己的约定拼一次，于是打过来的是 `/v1/v1/xxx`。用户看到的是
// 「网关 404」，会去怀疑网关坏了/模型不存在，而真因是 base URL 写重了一段。
//
// 三条口径：
//   1. 只认「/v1 后面又跟 /v1」的形态；`/v1beta/...`、`/v2/v1/...` 不误伤
//   2. 提示里直接给出**该改的地址形态**（两种改法都写出来）
//   3. **不静默重写**——重写等于替用户猜意图，而他明明配错了
//
// 运行：node --test test/unit/duplicated-v1-hint.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// 判据在 server.js 内联（那一层不可 require：它启动时会拉上游）。
// 所以这里**从源码里抠出同一条正则**，锁住它的语义——这是防漂移的做法：
// 有人改了 server.js 里的正则，本用例会失败并提示「两侧不一致」。
const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/server.js'), 'utf8');
// 抠出整个判据行（含缩进）：`const dupV1 = url.match(/.../)`。
// 换成新写法（比如抽成模块）本用例会失败并提示更新——这是**有意的**，
// 它防的正是「实测的提示还在、判据被悄悄改窄」。
const RE_LINE = SRC.match(/^[ \t]*const dupV1 = url\.match\((\/.*\/)\);$/m);
assert.ok(RE_LINE, 'server.js 里必须能找到 dupV1 的判据（重命名/删除都会被这里发现）');

/** 用源码里的字面量重建正则（保持单一来源，不在测试里复制一份） */
function loadRegex() {
  // eslint-disable-next-line no-new-func
  return new Function(`return ${RE_LINE[1]}`)();
}

const re = loadRegex();

test('重复 /v1 被判出来，并给出该改成什么', () => {
  const cases = [
    ['/v1/v1/chat/completions', '/v1/chat/completions'],
    ['/v1/v1/v1/messages', '/v1/messages'],
    ['/v1/v1/responses', '/v1/responses'],
    ['/v1/v1', '/v1'],
  ];
  for (const [input, want] of cases) {
    const m = input.match(re);
    assert.ok(m, `${input} 应判为重复 /v1`);
    assert.strictEqual(`/v1${m[2] || ''}`, want, `${input} 的修正形态`);
  }
});

test('正常路径不误伤（只认「/v1 后面又跟 /v1」）', () => {
  for (const input of [
    '/v1/chat/completions',
    '/v1/messages',
    '/v1/responses',
    '/v1/models',
    '/health',
    '/ping',
    // 下面两条最容易误伤：都不是「重复 /v1」
    '/v1beta/models/gemini-pro:generateContent',
    '/v2/v1/whatever',
    '/messages',
    '/api/v1/messages',
  ]) {
    assert.strictEqual(input.match(re), null, `${input} 不该被判为重复 /v1`);
  }
});

test('源码里的提示文案包含两种改法（不静默重写）', () => {
  // 用户拿到 404 时要能自己修好：两种配置形态各给一条
  assert.match(SRC, /base URL 已包含 \/v1 时不要再拼一次/, '要点明真因');
  assert.match(SRC, /code: 'duplicated_v1_prefix'/, '要给可编程判据');
  assert.match(SRC, /hint: \{ received: url, expected: cleanUrl \}/, '要给修正后的地址');
  // **不静默重写**：没有「自动改写成 cleanUrl 后继续处理」的分支
  const block = SRC.slice(SRC.indexOf('const dupV1'), SRC.indexOf('const dupV1') + 1600);
  assert.ok(!/url = cleanUrl/.test(block), '不该偷偷把 url 改回去继续处理——那是替用户猜意图');
});

test('命中时打一条 WARN 日志（这类错误靠用户自报很难定位）', () => {
  assert.match(SRC, /检测到重复 \/v1 前缀/, '日志里要能一眼看到');
});
