// scripts/check-proxy-redact.js - 验证 workbuddy/auth.list() 的代理脱敏
// 运行：node scripts/check-proxy-redact.js（或直接 node - <脚本>）
const auth = require('../src/workbuddy/auth');

const rows = auth.list();
const withProxy = rows.filter((r) => r.proxy);
console.log('账号数:', rows.length, '| 带代理:', withProxy.length);
if (withProxy.length) {
  console.log('proxy 形态样例:', JSON.stringify(withProxy[0].proxy));
}
// 原始形态泄漏检查：user:pass@host 里的凭证（冒号分隔）不能出现在任何字段
const leak = JSON.stringify(rows).match(/\/\/[^@/\s"]+:[^@/\s"]+@/);
console.log('凭证泄漏检查:', leak ? 'LEAK: ' + leak[0] : '无泄漏（脱敏有效）');
