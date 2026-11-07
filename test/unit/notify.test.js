// test/unit/notify.test.js - 健康告警推送（notify.js）离线测试
//
// 覆盖：五平台请求体形状（buildRequest 纯函数）、配置校验边界、配置落盘
// roundtrip、sendNotify 的 mock fetch 全链路（disabled 短路 / HTTP 非 2xx
// 如实报错 / 网络异常不抛）。不发真实 webhook。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-notify-'));
process.env.DUMATE_ADMIN_DATA = TMP;

const notify = require('../../src/notify');

test('配置校验：五类边界', () => {
  assert.deepStrictEqual(notify.validate({ enabled: true, type: 'feishu', url: 'https://x' }), []);
  assert.ok(notify.validate({ enabled: true, type: 'bad', url: 'https://x' })[0].includes('type'));
  assert.ok(notify.validate({ enabled: true, type: 'feishu', url: 'ftp://x' })[0].includes('http'));
  assert.ok(notify.validate({ enabled: true, type: 'telegram', url: 'https://t' })[0].includes('chat_id'));
  assert.ok(notify.validate(null)[0].includes('对象'));
});

test('buildRequest：五平台请求体形状', () => {
  const feishu = notify.buildRequest({ type: 'feishu', url: 'https://open.feishu.cn/hook/x' }, 'hi');
  assert.deepStrictEqual(feishu.body, { msg_type: 'text', content: { text: 'hi' } });
  const wecom = notify.buildRequest({ type: 'wecom', url: 'https://qy/x' }, 'hi');
  assert.deepStrictEqual(wecom.body, { msgtype: 'text', text: { content: 'hi' } });
  const ding = notify.buildRequest({ type: 'dingtalk', url: 'https://oapi/x' }, 'hi');
  assert.deepStrictEqual(ding.body, { msgtype: 'text', text: { content: 'hi' } });
  const tg = notify.buildRequest({ type: 'telegram', url: 'https://api.telegram.org/botT', chat_id: '42' }, 'hi');
  assert.strictEqual(tg.url, 'https://api.telegram.org/botT/sendMessage', 'sendMessage 拼在路径上');
  assert.deepStrictEqual(tg.body, { chat_id: '42', text: 'hi' });
  const gen = notify.buildRequest({ type: 'generic', url: 'https://my/hook' }, 'hi');
  assert.deepStrictEqual(gen.body, { text: 'hi' });
});

test('配置落盘 roundtrip + 覆盖合并', () => {
  notify.saveConfig({ enabled: true, type: 'wecom', url: 'https://qy/1' });
  notify.saveConfig({ type: 'feishu', url: 'https://feishu/2' });
  const cfg = notify.loadConfig();
  assert.strictEqual(cfg.enabled, true, '未传的字段保留');
  assert.strictEqual(cfg.type, 'feishu', '传了的字段覆盖');
  assert.ok(fs.existsSync(notify.FILE), '落盘到 DUMATE_ADMIN_DATA');
});

test('sendNotify：disabled 短路，不打网络', async () => {
  notify.saveConfig({ enabled: false });
  const r = await notify.sendNotify('x');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('disabled'));
});

test('sendNotify：mock fetch——body 到达、非 2xx 如实报错、网络异常不抛', async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (String(url).includes('fail')) return { ok: false, status: 502 };
    if (String(url).includes('boom')) throw new Error('ECONNRESET');
    return { ok: true, status: 200 };
  };
  try {
    notify.saveConfig({ enabled: true, type: 'feishu', url: 'https://feishu/hook/ok' });
    const ok = await notify.sendNotify('告警 1');
    assert.deepStrictEqual(ok, { ok: true });
    assert.strictEqual(calls[0].body.content.text, '告警 1');

    notify.saveConfig({ type: 'feishu', url: 'https://feishu/hook/fail' });
    const bad = await notify.sendNotify('x');
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.error.includes('502'));

    notify.saveConfig({ type: 'feishu', url: 'https://feishu/hook/boom' });
    const net = await notify.sendNotify('x');
    assert.strictEqual(net.ok, false);
    assert.ok(net.error.includes('ECONNRESET'), '网络异常转错误不抛');
  } finally {
    global.fetch = realFetch;
  }
});
