// src/prompt-guard.js - 出站提示词卫生（两项都是**默认关闭**的选通开关）
//
// 1. 合规词脱敏（DUMATE_DESENSITIZE=1 开启）：系统提示词里的合规敏感词会被
//    上游关键词审查整轮拒掉。在命中词的字符间插零宽空格（U+200B）让关键词
//    匹配失效而肉眼不变（buddy-proxy --desensitize 的思路）。词表来自
//    data/desensitize-words.txt（一行一词，# 注释行，无词表等于不生效）。
//    只做字面替换不改语义——开启前先确认词表内容是你要脱的词。
//    天然幂等：插过零宽空格的词不再连续，重复应用不会二次插入。
//
// 2. 工具输出截断（DUMATE_TOOL_OUTPUT_CAP=<字符数> 开启）：历史里 role:'tool'
//    的超大输出（一次 cat 大文件几万行）会灌爆上下文。超过 cap 截断并显式
//    标注原始长度——客户端看得见截断发生，不是静默丢失。0/未设 = 关闭。
//    只动 tool 消息：system / user 正文一个字都不碰（改写有失真风险）。
'use strict';

const fs = require('fs');
const path = require('path');

const ZWSP = '​';

function enabled() { return process.env.DUMATE_DESENSITIZE === '1'; }

function wordsFilePath() {
  return path.join(process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data'), 'desensitize-words.txt');
}

let cache = { at: 0, regexes: [] };

/** 词表 → 命中正则（长词优先，避免短词先匹配吃掉长词的一半）。60 秒缓存 */
function wordRegexes(now = Date.now()) {
  if (!enabled()) return [];
  if (cache.regexes.length && now - cache.at < 60000) return cache.regexes;
  let regexes = [];
  try {
    const raw = fs.readFileSync(wordsFilePath(), 'utf8');
    const words = [...new Set(raw.split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#')))]
      .sort((a, b) => b.length - a.length)
      .map((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
    regexes = words;
  } catch (e) { regexes = []; }
  cache = { at: now, regexes };
  return regexes;
}

/** 在命中词的字符间插零宽空格。幂等：插过的词不再连续，天然不会重复插入 */
function desensitizeText(text, regexes) {
  let out = String(text || '');
  for (const re of regexes) out = out.replace(re, (w) => [...w].join(ZWSP));
  return out;
}

/** 就地脱敏 OpenAI 体里全部 system 消息（字符串 content 与 parts 的 text 都处理） */
function desensitizeBody(body) {
  const regexes = wordRegexes();
  if (!regexes.length || !body || !Array.isArray(body.messages)) return body;
  for (const m of body.messages) {
    if (!m || m.role !== 'system') continue;
    if (typeof m.content === 'string') {
      m.content = desensitizeText(m.content, regexes);
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p && p.type === 'text' && typeof p.text === 'string') {
          p.text = desensitizeText(p.text, regexes);
        }
      }
    }
  }
  return body;
}

/** 截断历史里 role:'tool' 的超大输出。cap <= 0 / 未设 = 不干预 */
function capToolOutputs(body, cap) {
  const n = Number(cap);
  if (!Number.isFinite(n) || n <= 0 || !body || !Array.isArray(body.messages)) return body;
  for (const m of body.messages) {
    if (!m || m.role !== 'tool' || typeof m.content !== 'string') continue;
    if (m.content.length <= n) continue;
    const orig = m.content.length;
    m.content = m.content.slice(0, n) + `\n…[tool 输出已截断，原始 ${orig} 字符（DUMATE_TOOL_OUTPUT_CAP=${n}）]`;
  }
  return body;
}

module.exports = {
  enabled, wordsFilePath, desensitizeText, desensitizeBody, capToolOutputs,
};
