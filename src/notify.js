// src/notify.js - 健康告警推送（2026-11-06 清单项 4，借鉴 AIAutomator 的通知思路）
//
// 为什么要有这个模块：健康横幅只有「打开管理端才看见」——cookie 死了没人
// 知道，等用户想用的时候才发现。runOnce 结束时判一次健康面，crit 级告警
// 主动推到 webhook。**只推 crit**：warn 是「要留意」，推消息会养成狼来了。
//
// 适配五种 webhook（配置存 data/notify.json）：
//   feishu    飞书自定义机器人   {"msg_type":"text","content":{"text":...}}
//   wecom     企业微信机器人     {"msgtype":"text","text":{"content":...}}
//   dingtalk  钉钉机器人         {"msgtype":"text","text":{"content":...}}
//   telegram  TG Bot             POST <url>/sendMessage {chat_id, text}
//             （url 填 https://api.telegram.org/bot<token>，不含 /sendMessage）
//   generic   通用 JSON          POST {"text": ...}——自建 webhook/ntfy 等随意接
//
// 纪律：发送失败只 console.warn，绝不抛——通知挂了不能把保活轮也拖挂；
// fetch 用 Node 18+ 全局（package.json engines >=18），5 秒超时。
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'notify.json');

const TYPES = ['feishu', 'wecom', 'dingtalk', 'telegram', 'generic'];

function loadConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (e) {
    return {};
  }
}

function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  return next;
}

/** 配置校验。enabled 时 url/type 必填、telegram 需 chat_id。返回错误串数组 */
function validate(cfg) {
  const problems = [];
  if (!cfg || typeof cfg !== 'object') return ['配置必须是对象'];
  if (!TYPES.includes(cfg.type)) problems.push(`type 必须是 ${TYPES.join(' / ')}`);
  const url = String(cfg.url || '').trim();
  if (!/^https?:\/\//.test(url)) problems.push('url 必须是 http(s) 地址');
  if (cfg.type === 'telegram' && !String(cfg.chat_id || '').trim()) {
    problems.push('telegram 需要 chat_id');
  }
  return problems;
}

/** 按 type 组请求。返回 { url, headers, body }；组不出来抛错（调用方 catch） */
function buildRequest(cfg, text) {
  const url = String(cfg.url || '').trim();
  switch (cfg.type) {
    case 'feishu':
      return { url, body: { msg_type: 'text', content: { text } } };
    case 'wecom':
      return { url, body: { msgtype: 'text', text: { content: text } } };
    case 'dingtalk':
      return { url, body: { msgtype: 'text', text: { content: text } } };
    case 'telegram':
      // url 形如 https://api.telegram.org/bot<token>——sendMessage 拼在路径上
      return { url: `${url.replace(/\/$/, '')}/sendMessage`, body: { chat_id: cfg.chat_id, text } };
    case 'generic':
    default:
      return { url, body: { text } };
  }
}

/** 发送一条通知。返回 { ok, error? }——网络失败/非 2xx 都如实带错误，不抛 */
async function sendNotify(text) {
  const cfg = loadConfig();
  if (!cfg.enabled) return { ok: false, error: 'notify disabled' };
  const problems = validate(cfg);
  if (problems.length) return { ok: false, error: problems.join('；') };
  try {
    const { url, body } = buildRequest(cfg, String(text || '').slice(0, 4000));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        return { ok: false, error: `webhook 返回 HTTP ${res.status}` };
      }
      return { ok: true };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { loadConfig, saveConfig, validate, sendNotify, buildRequest, TYPES, FILE };
