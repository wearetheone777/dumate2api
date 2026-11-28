// src/workbuddy/jsonscan.js - JSON 字节级扫描器（无依赖，两个消费方共用）
//
// 消费方：
//   chat.js       —— 11151 空 text 段补位（字符串 content 的嗅探补位）
//   sanitize.js   —— tool_calls.arguments 的指纹清洗（批次五 ③）
//
// 为什么不用 JSON.parse 往返：大整数转 float64 丢精度、转义形态被归一、键序可能
// 变化——工具参数里的 64 位 id 与客户端原文都必须保真。扫描器只回答「每个值在
// 源串的哪个区间」，改写由调用方按区间拼接，其余字节一动不动。
//
// 前提：src 必须已是合法 JSON（调用方先 JSON.parse 验过整体或构造时保证），
// 结构容错从简——任何异常形态一律返回 -1/null，调用方回落原文。
'use strict';

const WS_RE = /[ \t\r\n]/;

/** 越过单个 JSON 值，返回结束下标；无法解析返回 -1。 */
function scanJsonValue(src, i) {
  const ch = src[i];
  if (ch === '"') {
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '"') return i + 1;
      i++;
    }
    return -1;
  }
  if (ch === '{' || ch === '[') {
    const close = ch === '{' ? '}' : ']';
    i++;
    for (;;) {
      while (i < src.length && WS_RE.test(src[i])) i++;
      if (src[i] === close) return i + 1;
      if (i >= src.length) return -1;
      if (ch === '{') {
        if (src[i] !== '"') return -1;
        const k = scanJsonValue(src, i);
        if (k < 0) return -1;
        i = k;
        while (i < src.length && WS_RE.test(src[i])) i++;
        if (src[i] !== ':') return -1;
        i++;
        while (i < src.length && WS_RE.test(src[i])) i++;
      }
      const v = scanJsonValue(src, i);
      if (v < 0) return -1;
      i = v;
      while (i < src.length && WS_RE.test(src[i])) i++;
      if (src[i] === ',') { i++; continue; }
      if (src[i] === close) return i + 1;
      return -1;
    }
  }
  let j = i;
  while (j < src.length && !WS_RE.test(src[j]) && src[j] !== ','
    && src[j] !== '}' && src[j] !== ']' && src[j] !== ':') j++;
  const tok = src.slice(i, j);
  if (!tok.length) return -1;
  if (/^-?\d/.test(tok)) return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(tok) ? j : -1;
  if (tok === 'true' || tok === 'false' || tok === 'null') return j;
  return -1;
}

/** 列出 JSON 容器（'[' 数组元素 / '{' 对象成员）在源串中的区间与键名。 */
function rawSpans(src, open) {
  let i = 0;
  while (i < src.length && WS_RE.test(src[i])) i++;
  if (src[i] !== open) return null;
  const close = open === '[' ? ']' : '}';
  i++;
  const spans = [];
  for (;;) {
    while (i < src.length && WS_RE.test(src[i])) i++;
    if (src[i] === close) return { spans, end: i + 1 };
    if (i >= src.length) return null;
    let key = null;
    if (open === '{') {
      if (src[i] !== '"') return null;
      const k = scanJsonValue(src, i);
      if (k < 0) return null;
      try { key = JSON.parse(src.slice(i, k)); } catch (e) { return null; }
      i = k;
      while (i < src.length && WS_RE.test(src[i])) i++;
      if (src[i] !== ':') return null;
      i++;
      while (i < src.length && WS_RE.test(src[i])) i++;
    }
    const start = i;
    const end = scanJsonValue(src, i);
    if (end < 0) return null;
    spans.push({ key, start, end });
    i = end;
    while (i < src.length && WS_RE.test(src[i])) i++;
    if (src[i] === ',') { i++; continue; }
    if (src[i] === close) return { spans, end: i + 1 };
    return null;
  }
}

/**
 * 递归收集 src 里**每个字符串值**的区间（含嵌套；对象的键不收——键名不是
 * 散文，改了会破坏契约）。返回值越过整个顶层值之后的下标；-1 = 解析失败。
 * @param {string} src 合法 JSON 文本
 * @param {number} i 顶层值的起始下标
 * @param {Array<[number, number]>} out 收集区间（含引号）
 */
function collectStringSpans(src, i, out) {
  const ch = src[i];
  if (ch === '"') {
    const end = scanJsonValue(src, i);
    if (end < 0) return -1;
    out.push([i, end]);
    return end;
  }
  if (ch === '{' || ch === '[') {
    const close = ch === '{' ? '}' : ']';
    let j = i + 1;
    for (;;) {
      while (j < src.length && WS_RE.test(src[j])) j++;
      if (src[j] === close) return j + 1;
      if (j >= src.length) return -1;
      if (ch === '{') {
        if (src[j] !== '"') return -1;
        const k = scanJsonValue(src, j); // 键：越过不收
        if (k < 0) return -1;
        j = k;
        while (j < src.length && WS_RE.test(src[j])) j++;
        if (src[j] !== ':') return -1;
        j++;
        while (j < src.length && WS_RE.test(src[j])) j++;
      }
      const v = collectStringSpans(src, j, out);
      if (v < 0) return -1;
      j = v;
      while (j < src.length && WS_RE.test(src[j])) j++;
      if (src[j] === ',') { j++; continue; }
      if (src[j] === close) return j + 1;
      return -1;
    }
  }
  return scanJsonValue(src, i); // 数字/字面量：越过即可
}

module.exports = { scanJsonValue, rawSpans, collectStringSpans, WS_RE };
