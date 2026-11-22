// src/workbuddy/dump.js - 11-128 / 风控取证开关（P1-5）
//
// 出处：docs/WORKBUDDY-FUSION.md P1-5（hub 的 `WB_DUMP_11_128`）。hub 2026-11-06
// 停更后，这个排障能力只能自己养——上游正在收紧非官方客户端识别，11-128
// （"Illegal API invocation from an unapproved channel"）是 Claude Code 类请求
// 最常见的拒绝码。
//
// hub 的排障纪律（照抄，不自己发明）：
//   「先收集同一请求的身份头、最小请求和提示词对照结果，**不要先轮换账号**」
// ——11-128 是**请求形态**判定，不是账号问题；换号只会让更多号暴露在同一形态下。
//
// 两档（env `DUMATE_WORKBUDDY_DUMP_11_128`）：
//   1      → 只写**脱敏摘要**（头名清单、body 长度与结构、指纹命中位置，
//            **不含提示词明文**）——默认档，可以长期开着
//   full   → 额外写出站 body 原文（含提示词），**需显式开启**，落盘文件名带
//           `-full` 便于单独清理
//   未设/0 → 关闭（默认）
//
// 触发条件默认只有 11-128 与 11128；`DUMATE_WORKBUDDY_DUMP_CODES=code1,code2`
// 可扩到任意错误码（hub 的「或做成任意错误码可配」）。
//
// 落盘 `data/workbuddy-11-128-dumps/<ts>-<code>.json`，走 filelock.renameAtomic
// （项目惯例）。**目录里是请求原文，含用户提示词**——与 web-accounts.json 明文
// 存 cookie 同一种信任边界：本机 data/ 已被 gitignore。
const fs = require('fs');
const path = require('path');
const filelock = require('../filelock');

const DEFAULT_CODES = ['11-128', '11128'];

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
}

function dumpDir() {
  return path.join(dataDir(), 'workbuddy-11-128-dumps');
}

/**
 * 当前取证档位：'off' | 'summary' | 'full'。
 * 每次现读 env（改配置不必重启网关——与 Qoder read-idle 当年读死 env 的教训）。
 */
function mode() {
  const v = String(process.env.DUMATE_WORKBUDDY_DUMP_11_128 || '').trim().toLowerCase();
  if (v === 'full') return 'full';
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on' || v === 'summary') return 'summary';
  return 'off';
}

/** 触发码表（默认 11-128 / 11128；env 可扩） */
function codes() {
  const env = String(process.env.DUMATE_WORKBUDDY_DUMP_CODES || '').trim();
  if (!env) return DEFAULT_CODES.slice();
  const list = env.split(/[\n,，;；]/).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_CODES.slice();
}

/**
 * 响应体是否命中某个取证码。**数字带负向断言**（111280 不该被 11128 吃掉，
 * 与 constants.js 的风控码判据同一理由）。
 */
function matchesCode(text, list) {
  const s = String(text || '');
  if (!s) return null;
  for (const code of list || codes()) {
    const c = String(code);
    if (/^\d+$/.test(c)) {
      const re = new RegExp(`"code"\\s*:\\s*"?${c}"?(?!\\d)|\\bcode ${c}(?!\\d)`);
      if (re.test(s)) return c;
    } else if (s.includes(c)) {
      return c;
    }
  }
  return null;
}

/** 脱敏：把疑似凭证片段替换掉（摘要档也可能带出 OAuth 片段） */
function redact(s) {
  return String(s == null ? '' : s)
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, 'Bearer <redacted>')
    .replace(/\b(sk|dmk)_[A-Za-z0-9_-]{8,}/g, '$1_<redacted>')
    .replace(/"refreshToken"\s*:\s*"[^"]*"/g, '"refreshToken":"<redacted>"')
    .replace(/"accessToken"\s*:\s*"[^"]*"/g, '"accessToken":"<redacted>"');
}

/**
 * 摘要档内容：只看**形状**，不看内容。
 * 提示词明文一律不进摘要——摘要要能长期开着，含明文就成了隐私事故。
 */
function summaryOf({ region, model, headers, bodyText, code, status }) {
  let parsed = null;
  try { parsed = JSON.parse(bodyText); } catch (e) { parsed = null; }
  const h = headers && typeof headers === 'object' ? headers : {};
  const headerNames = Object.keys(h).sort();
  const identityHeaders = headerNames.filter((n) => /^x-(user|enterprise|domain|no-|ide|product|codebuddy|agent|request|conversation)/i.test(n));
  const roles = Array.isArray(parsed && parsed.messages)
    ? parsed.messages.map((m) => (m && m.role) || '?')
    : null;
  const systemLens = Array.isArray(parsed && parsed.messages)
    ? parsed.messages.map((m) => (m && typeof m.content === 'string' ? m.content.length : null))
    : null;
  return {
    at: new Date().toISOString(),
    region: region || '',
    model: model || '',
    status: status || 0,
    code,
    bodyBytes: Buffer.byteLength(String(bodyText || ''), 'utf8'),
    // 结构指纹：这些是 11-128 判定真正看的东西
    shape: parsed ? {
      keys: Object.keys(parsed).sort(),
      stream: parsed.stream === true,
      messageCount: roles ? roles.length : null,
      roles,
      contentLengths: systemLens,
      hasTools: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
      hasConversationId: typeof parsed.conversation_id === 'string',
      model: parsed.model || '',
      maxTokens: parsed.max_tokens != null ? parsed.max_tokens : null,
    } : null,
    headers: { count: headerNames.length, names: headerNames, identity: identityHeaders },
    ua: redact(h['User-Agent'] || h['user-agent'] || ''),
    hint: '11-128 是请求形态判定，不是账号问题——先对照这里的环境头与消息形状，不要先换号。',
  };
}

/**
 * 写一份取证文件。
 * @param {object} info { region, model, headers, bodyText, code, status }
 * @returns {string|null} 落盘路径（关闭 / 失败时 null）
 *
 * **文件名必须保证唯一**：原来只用「ISO 时间戳（毫秒）+ 码 + 档位」，同一毫秒
 * 内两次命中会**静默覆盖**——真实场景是多账号并发撞 11-128（取证档要长期开着，
 * 正是最可能同时触发的时候），覆盖等于丢样本；单测里两次连写也会撞到。
 * 现在追加「进程内自增序号 + 4 位随机」，排序仍按时间前缀（同毫秒内的顺序由
 * 序号 varchar 顺序保证，因为序号补零到固定宽度）。
 */
let dumpSeq = 0;

function dump(info) {
  const m = mode();
  if (m === 'off') return null;
  try {
    const code = String((info && info.code) || 'unknown');
    const dir = dumpDir();
    fs.mkdirSync(dir, { recursive: true });
    const full = m === 'full';
    const row = {
      ...summaryOf(info || {}),
      level: m,
    };
    if (full) {
      // full 档：原文进独立字段，摘要仍保留（排障时先看摘要再翻原文）
      row.bodyText = redact(String((info && info.bodyText) || ''));
      row.note = 'full 档含提示词原文（token 已脱敏），排查完请删除该文件';
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    // 序号补零到 6 位：同毫秒内的先后由它决定（字典序 == 写入序）
    dumpSeq = (dumpSeq + 1) % 1000000;
    const seq = String(dumpSeq).padStart(6, '0');
    const rnd = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
    const name = `${ts}-${seq}-${rnd}-${code}${full ? '-full' : ''}.json`;
    const target = path.join(dir, name);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(row, null, 2), 'utf8');
    filelock.renameAtomic(tmp, target);
    return target;
  } catch (e) {
    // 取证失败绝不能影响正在转发的请求（与 reqlog 同一纪律）
    return null;
  }
}

/** 便于管理端显示：当前档位与码表 */
function status() {
  return { mode: mode(), codes: codes(), dir: dumpDir() };
}

/** 列出已落盘的取证文件（新的在前，最多 limit 条） */
function list(limit = 50) {
  try {
    return fs.readdirSync(dumpDir())
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, Math.max(1, limit))
      .map((f) => {
        const p = path.join(dumpDir(), f);
        let bytes = null;
        try { bytes = fs.statSync(p).size; } catch (e) { /* 刚被删掉 */ }
        return { name: f, bytes, full: /-full\.json$/.test(f) };
      });
  } catch (e) {
    return [];
  }
}

module.exports = { DEFAULT_CODES, mode, codes, matchesCode, redact, summaryOf, dump, status, list, dumpDir };
