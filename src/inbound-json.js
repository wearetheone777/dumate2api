// 入站 JSON 统一解析（WorkBuddy 融合批 P1-2，misakano #295）。此前每个入口
// 各自 `JSON.parse`，有两类静默坑：① 带 BOM 的 body（PowerShell 5.1 落盘
// 再读回、部分 SDK 的产物）首字符是 U+FEFF，JSON.parse 直接失败——客户端只看到
// 「invalid」，自己看不出哪错了；② 解析失败时错误体不带原文回显，远程排障
// 只能靠猜。这里剥 BOM、trim，失败时带**前 48 字符**原文与解析错误原因。
// 畸形 body 在网关就被 400 拒绝，绝不放去打上游（一次额度往返白烧）。
//
// allowEmpty：工具/媒体端点原来的 `JSON.parse(bodyStr || '{}')` 语义——
// 空 body 等价 `{}`；五个协议入口不开（空 body 一样回 400，与原行为一致）。
//
// server.js（9080）与 web-gateway.js（9084）共用：这是**同一份协议事实**，
// 写两份必然漂移（CLAUDE.md 的老规矩）。

function parseJsonBody(bodyStr, { allowEmpty = false } = {}) {
  if (bodyStr == null || bodyStr === '') {
    return allowEmpty ? { value: {} } : { err: 'empty body', sample: '' };
  }
  let s = String(bodyStr);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // UTF-8 BOM decoded
  s = s.trim();
  if (!s) return allowEmpty ? { value: {} } : { err: 'empty body', sample: '' };
  try {
    return { value: JSON.parse(s) };
  } catch (e) {
    return { err: e.message, sample: s.slice(0, 48) };
  }
}

// 各协议的「Invalid JSON body」文案生成：形状照旧，message 追加原文回显。
// sample 为空（空 body）时标 (empty)；sample 里的换行压成空格，避免 SSE/日志断行。
function invalidJsonMessage(p) {
  const head = p && p.sample ? p.sample.replace(/\s+/g, ' ') : '(empty)';
  const reason = p && p.err && p.err !== 'empty body' ? ` (${p.err})` : '';
  return `Invalid JSON body: "${head}"${reason}`;
}

module.exports = { parseJsonBody, invalidJsonMessage };
