// scripts/check-upstream-projects.js - 参考项目增量检查（自动化任务每轮调用）
//
// 对已知的 TRAE/Qoder 生态参照项目，列出「最近 N 天内的新提交」。
// 无新提交时输出一行汇总；有新提交时打印 repo + 日期 + 标题。
// 用 gh api 拿原始 JSON 由 Node 解析——execSync 在 Windows 走 cmd.exe，
// --jq 的表达式会被 shell 吃掉，不能依赖它。
// GitHub 走代理 127.0.0.1:7897。
//
// 用法：node scripts/check-upstream-projects.js [天数，默认 2]
const { execFileSync } = require('child_process');

const DAYS = Number(process.argv[2] || 2);
const SINCE = new Date(Date.now() - DAYS * 86400000).toISOString();
const REPOS = [
  'autumnsentiment/Trae2api-cn',
  'shuishuipingan/trae2api-hub',
  'ZedeX/trae-local-api',
  'shuishuipingan/qoder2api-hub',
  'smart-open/TraeWorkAssistant',
  'NextAgentX/qoder-trae-workbuddy-switch',
  'connectedGraph/trae2api-web',
  'JeffHu0912/trae2api',
];

function ghJson(path) {
  const out = execFileSync('gh', ['api', path], {
    env: { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:7897' },
    encoding: 'utf8', timeout: 30000, shell: false,
  });
  return JSON.parse(out);
}

let found = 0;
for (const repo of REPOS) {
  try {
    const commits = ghJson(`repos/${repo}/commits?since=${SINCE}&per_page=20`);
    const lines = (Array.isArray(commits) ? commits : [])
      .map((c) => {
        const d = (c.commit && c.commit.committer && c.commit.committer.date) || '';
        const msg = ((c.commit && c.commit.message) || '').split('\n')[0];
        return `${d.slice(0, 16)} ${msg}`;
      })
      .filter(Boolean);
    if (lines.length) {
      found++;
      console.log(`=== ${repo}`);
      console.log(lines.join('\n'));
    }
  } catch (e) {
    console.log(`=== ${repo}: 查询失败 ${String(e.message).split('\n')[0].slice(0, 100)}`);
  }
}
if (!found) console.log(`(所有参照项目近 ${DAYS} 天无新提交)`);
