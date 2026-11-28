// 三频道内存环（批次十八）——channelOf 判据、分环不被冲掉、过滤、sink 不占订阅者名额。
// logbuffer 不读 store，无环境耦合，直接 require。
const test = require('node:test');
const assert = require('node:assert');

const logbuffer = require('../../src/admin/logbuffer');

test('channelOf：显式标签直接命中，剥离 server.js 的 ISO 时间戳前缀后再判', () => {
  const { channelOf } = logbuffer;
  assert.strictEqual(channelOf('[chat] 对话流量'), 'chat');
  assert.strictEqual(channelOf('[task] 签到完成'), 'task');
  assert.strictEqual(channelOf('[sys] boot'), 'sys');
  assert.strictEqual(channelOf('[2026-11-28T03:00:00.000Z] [keepalive] 签到完成'), 'task');
  assert.strictEqual(channelOf('[2026-11-28T03:00:00.000Z] Starting gateway on 9080'), 'sys');
  assert.strictEqual(channelOf('[keepalive] 余额刷新完成'), 'task');
  assert.strictEqual(channelOf('[workbuddy-window] 窗口探针到点'), 'task');
  assert.strictEqual(channelOf('[alerts] 规则评估'), 'sys'); // 告警是系统侧，不是任务
  assert.strictEqual(channelOf('随机输出'), 'sys');
  assert.strictEqual(channelOf(''), 'sys');
  assert.strictEqual(channelOf(null), 'sys');
});

test('三频道分环：task 行不被 chat 流量冲掉（分环的意义所在）', () => {
  const lb = logbuffer.create({ capacity: 5 });
  for (let i = 0; i < 10; i++) lb.push('log', [`[chat] 对话流量 ${i}`]);
  lb.push('log', ['[task] 签到完成 account=1']);
  // chat 环已被挤到只剩 5 行，但 task 环的行还在
  assert.ok(lb.read().some((x) => x.text.includes('签到完成')), 'task 行未被 chat 冲掉');
  assert.strictEqual(lb.read({ channel: 'chat' }).length, 5);
  assert.strictEqual(lb.read({ channel: 'task' }).length, 1);
  assert.strictEqual(lb.size(), 6); // chat 5 + task 1 + sys 0
  assert.deepStrictEqual(lb.sizeByChannel(), { chat: 5, task: 1, sys: 0 });
});

test('read 的 channel/level/keyword 过滤；未知频道返回空，不猜不回落', () => {
  const lb = logbuffer.create();
  lb.push('log', ['[task] 打卡完成']);
  lb.push('warn', ['[chat] 上游报错']);
  lb.push('log', ['普通 sys 行']);
  assert.strictEqual(lb.read({ channel: 'task' }).length, 1);
  assert.strictEqual(lb.read({ channel: 'nonsense' }).length, 0);
  assert.strictEqual(lb.read({ level: 'warn' }).length, 1);
  assert.strictEqual(lb.read({ keyword: '打卡' }).length, 1);
  // 合并视图按 seq 升序
  const all = lb.read();
  assert.deepStrictEqual(all.map((x) => x.ch), ['task', 'chat', 'sys']);
});

test('敏感行既不进环也不进 sink——写盘前脱敏的判据在 entry() 一处收口', () => {
  const lb = logbuffer.create();
  const seen = [];
  lb.addSink((e) => seen.push(e));
  lb.push('log', ['token=abc123 那行必须整行丢弃']);
  lb.push('log', ['普通行']);
  assert.strictEqual(lb.read().length, 1);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].text, '普通行');
  assert.strictEqual(seen[0].ch, 'sys');
});

test('中文敏感标签整行丢弃（--reset-admin 横幅实测漏过 ASCII 判据的缺口）', () => {
  const lb = logbuffer.create();
  lb.push('log', ['[2026-11-28T14:06:51.898Z]     密码:   hunter2-value']);
  lb.push('log', ['口令：全角冒号的值也要丢']);
  lb.push('log', ['凭据不可用，跳过该账号']);        // 正文词、无分隔符 → 不误伤
  lb.push('log', ['密钥长度 2048，算法 RSA']);       // 同上
  const texts = lb.read().map((x) => x.text);
  assert.strictEqual(texts.length, 2);
  assert.ok(texts.every((t) => !t.includes('hunter2')), '密码行不得入环');
  assert.ok(texts.includes('凭据不可用，跳过该账号'));
  assert.ok(texts.includes('密钥长度 2048，算法 RSA'));
});

test('sink 不占订阅者名额；addSink 返回解挂函数', () => {
  const lb = logbuffer.create();
  lb.addSink(() => {});
  assert.strictEqual(lb.sinkCount(), 1);
  assert.strictEqual(lb.subscriberCount(), 0); // 互不挤占
  const off = lb.addSink(() => {});
  off();
  assert.strictEqual(lb.sinkCount(), 1);
});

test('entry 带 ch 字段；subscriber 收到的条目也带', () => {
  const e = logbuffer.entry('log', ['[keepalive] hi']);
  assert.strictEqual(e.ch, 'task');
  const lb = logbuffer.create();
  const got = [];
  lb.subscribe((x) => got.push(x));
  lb.push('log', ['[task] 从订阅者出口也能看到频道']);
  assert.strictEqual(got[0].ch, 'task');
});
