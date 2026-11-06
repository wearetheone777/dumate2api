// src/qianfan-raw.js - 千帆原生透传（qianfan/ 前缀）
//
// 与搭子应用链路 `/gateway/apis/v1/chat/completions` 的区别（2026-10-31 实测）：
//
//   应用链路（apis/v1）        千帆原生（v2）
//   ------------------------  --------------------------
//   原生 tools     支持        支持
//   response_format 400        **支持（JSON mode / json_schema）**
//   视觉            支持        支持
//   模型名          应用别名     **千帆原生模型名**（应用别名会 401 invalid_model）
//
// 所以它不是一个"更好的搭子"，而是**另一个模型命名空间**——把两者混在一起
// 只会让调用方以为 glm-5 在两边都能用。用显式前缀 `qianfan/` 隔离：
// 日志里仍记成 dumate（同一份凭证、同一份额度），但模型名必须写千帆的。
//
// 凭证与对话完全共用 web-pool：同一个账号池、同一套冷却/熔断。
const https = require('https');
const webPool = require('./web-pool');

const HOST = webPool.GATEWAY_HOST;
const BASE = '/gateway/v2';
const CHAT_PATH = '/chat/completions';
const TIMEOUT_MS = 600000;

// 实测可用的千帆原生模型（2026-10-31）。**列表接口不存在**
// （`/gateway/v2/models` 回 404「dumate api not registered」），所以只能列
// 验证过的那个。其它模型名原样透传——上游会明确报 invalid_model。
const KNOWN_MODELS = ['qwen3.5-35b-a3b'];

// 实测元数据（2026-11-06，probe-qianfan-caps.js，六发探针的实测矩阵）：
//
//   输入 tokens   max_tokens   结果
//   126,512       1            200 通过
//   506,012       1            400 "input token limit is 258048"
//   258,050       1            200 通过（超文案数字 2 个 token）
//   258,050       65,536       200 通过（max_tokens 不参与联合校验）
//   262,200       1            400 "input token limit is 258048"（固定文案）
//   100,000,000   -            400 "max_tokens range is [1, 65536]"
//
// 结论：
//   真实窗口 262,144（256K）。文案的 258048 = 262,144 − 4,096，是扣掉
//   默认输出预留的**标称输入限额**，无论超多少都报同一个数——不能按字面
//   当硬边界（258,050 实测通过）。contextWindow 按保守的标称值声明。
//   max_tokens 上限 65,536（比 glm-5 的 131072 小一半，与 35B-A3B 小杯
//   定位一致）；计费 input/output 分价 0.5 / 4.0 积分/千token（两点定标）。
//   400 错误链同时证实上游是千帆官方 API（qianfan.baidubce.com/v2）。
const MODEL_META = {
  'qwen3.5-35b-a3b': {
    contextWindow: 258048,
    contextNote: '窗口 262,144（256K）；上游文案 "input token limit is 258048" = 262,144−4,096 默认输出预留的标称值（实测 258,050 输入通过、262,200 拒绝），客户端声明按保守标称 258,048',
    maxTokens: 65536,
    maxTokensNote: '上游 400 明示 "max_tokens range is [1, 65536]"（比 glm-5 的 131072 小一半）；max_tokens 不与输入做联合校验（258,050 输入 + 65,536 max_tokens 实测通过），网关不 clamp',
    rateIn: 0.5,
    rateOut: 4.0,
  },
};

function status() {
  try {
    const p = webPool.pick(new Set());
    return { ready: !!p, accounts: p ? 1 : 0, error: p ? '' : '网页账号池里没有可用账号' };
  } catch (e) {
    return { ready: false, accounts: 0, error: e.message };
  }
}

function listModels() {
  return KNOWN_MODELS.slice();
}

/** 出站请求体（纯函数，便于离线验证）：去前缀、按流式开关补 stream_options */
function buildRequest(payload, stream) {
  const body = { ...(payload || {}) };
  body.model = String(body.model || '').replace(/^qianfan\//, '');
  body.stream = !!stream;
  if (stream) body.stream_options = { include_usage: true };
  else delete body.stream_options;
  return body;
}

function requestStream(token, body, onChunk) {
  return new Promise((resolve, reject) => {
    const u = new URL('https://' + HOST + BASE + CHAT_PATH);
    const payload = JSON.stringify(body);
    let sent = false;
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      timeout: TIMEOUT_MS,
      headers: {
        Authorization: 'Bearer ' + token,
        'X-Appbuilder-From': 'openclaw',
        'X-Dumate-Client-Type': 'web',
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      if (res.statusCode >= 400) {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { b += c; });
        res.on('end', () => {
          const e = new Error(`qianfan ${res.statusCode}: ${b.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
          e.statusCode = res.statusCode;
          finish(reject, e);
        });
        return;
      }
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        buf += dec.write(chunk);
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          if (raw === '[DONE]') { onChunk('[DONE]'); continue; }
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (e) { /* 非 JSON 帧照原样转发 */ }
          if (parsed && parsed.error && !sent) {
            const err = new Error(`qianfan: ${parsed.error.message || JSON.stringify(parsed.error).slice(0, 160)}`);
            err.statusCode = Number(parsed.error.code) || 502;
            try { req.destroy(); } catch (e) { /* 已结束 */ }
            return finish(reject, err);
          }
          sent = true;
          onChunk(raw);
        }
      });
      res.on('end', () => {
        buf += dec.end();
        const tail = buf.trim();
        if (tail.startsWith('data:')) {
          const raw = tail.slice(5).trim();
          if (raw === '[DONE]') onChunk('[DONE]');
          else if (raw) onChunk(raw);
        }
        finish(resolve, { status: res.statusCode });
      });
      res.on('error', (e) => finish(reject, e));
    });
    req.on('error', (e) => finish(reject, e));
    req.on('timeout', () => { req.destroy(); finish(reject, new Error('qianfan: timeout')); });
    req.write(payload);
    req.end();
  });
}

function requestJSON(token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL('https://' + HOST + BASE + CHAT_PATH);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      timeout: 300000,
      headers: {
        Authorization: 'Bearer ' + token,
        'X-Appbuilder-From': 'openclaw',
        'X-Dumate-Client-Type': 'web',
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const e = new Error(`qianfan ${res.statusCode}: ${b.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
          e.statusCode = res.statusCode;
          return reject(e);
        }
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('qianfan: 响应不是 JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('qianfan: timeout')); });
    req.write(payload);
    req.end();
  });
}

/**
 * provider 接口（与 qwenwork/traework/qoder 同形）。
 *
 * `onChunk` 存在 = 流式：逐帧回调 OpenAI chunk 的 JSON 字符串，最后补 `[DONE]`。
 * 不存在 = 非流式：返回聚合后的 OpenAI chat.completion 对象。
 */
async function send(payload, onChunk, opts = {}) {
  const stream = !!onChunk;
  const body = buildRequest(payload, stream);

  const tried = new Set();
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    const p = webPool.pick(tried);
    if (!p) break;
    const id = p.account.id;
    tried.add(id);
    if (opts.onAccount) {
      try { opts.onAccount(p.account.name || p.account.nickname || `账号 ${id}`); } catch (e) { /* 上报失败不影响请求 */ }
    }
    const t = await webPool.getToken(p.account);
    if (!t.ok) {
      lastErr = Object.assign(new Error(t.error || '取 token 失败'), { statusCode: t.expired ? 401 : 502 });
      webPool.markFailure(id, { status: lastErr.statusCode, message: lastErr.message, model: body.model });
      continue;
    }
    if (opts.onModel) {
      try { opts.onModel(body.model); } catch (e) { /* 同上 */ }
    }
    try {
      if (stream) {
        await requestStream(t.token, body, onChunk);
        webPool.markSuccess(id);
        return { streamed: true };
      }
      const out = await requestJSON(t.token, body);
      webPool.markSuccess(id);
      return out;
    } catch (e) {
      const st = Number(e.statusCode) || 0;
      webPool.markFailure(id, { status: st, message: e.message, model: body.model });
      lastErr = e;
      // 4xx（除 401/402/429）是请求本身的问题，换号无用
      if (st >= 400 && st < 500 && st !== 401 && st !== 402 && st !== 429) throw e;
    }
  }
  throw lastErr || new Error('qianfan 没有可用账号');
}

module.exports = { status, listModels, send, buildRequest, KNOWN_MODELS, MODEL_META };
