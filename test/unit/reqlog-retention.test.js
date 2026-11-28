// test/unit/reqlog-retention.test.js - P2-3 请求日志保留策略
//
// 纪律：只清归档 .1，正在写的主文件永不裁剪；0 = 不限；面板 > env > 默认。
// 运行：node --test test/unit/reqlog-retention.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reqlog-retention-'));
process.env.DUMATE_ADMIN_DATA = tmp;
process.env.DUMATE_REQLOG_RETENTION_DAYS = '7';
process.env.DUMATE_REQLOG_MAX_LINES = '50';

const reqlog = require('../../src/reqlog');
const livecfg = require('../../src/livecfg');
const FILE = path.join(tmp, 'requests.jsonl');
const ARCHIVE = `${FILE}.1`;

function reset() {
  try { fs.unlinkSync(FILE); } catch (e) { /* 不存在 */ }
  try { fs.unlinkSync(ARCHIVE); } catch (e) { /* 不存在 */ }
  try { fs.unlinkSync(livecfg.filePath()); } catch (e) { /* 不存在 */ }
  livecfg._resetForTest();
}

test.beforeEach(reset);
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } });

test('retentionOf：env 作默认，0 = 不限', () => {
  assert.deepStrictEqual(reqlog.retentionOf(), { days: 7, maxLines: 50 });
  livecfg.Store({ reqlogRetention: { days: 2 } });
  assert.strictEqual(reqlog.retentionOf().days, 2, '面板覆盖 env');
  assert.strictEqual(reqlog.retentionOf().maxLines, 50, '未提交项仍回 env');
  livecfg.Store({ reqlogRetention: { days: 0, maxLines: 0 } });
  assert.deepStrictEqual(reqlog.retentionOf(), { days: 0, maxLines: 0 }, '显式 0 = 不限');
});

test('pruneArchive：过期归档整体删除', () => {
  fs.writeFileSync(ARCHIVE, '{"ts":1}\n', 'utf8');
  const old = Date.now() - 10 * 86400000;
  fs.utimesSync(ARCHIVE, old / 1000, old / 1000);
  reqlog.pruneArchive();
  assert.strictEqual(fs.existsSync(ARCHIVE), false);
});

test('pruneArchive：按行数裁剪归档，只留最新 N 条', () => {
  livecfg.Store({ reqlogRetention: { days: 0, maxLines: 3 } });
  fs.writeFileSync(ARCHIVE, Array.from({ length: 8 }, (_, i) => `{"ts":${i}}`).join('\n') + '\n', 'utf8');
  reqlog.pruneArchive();
  const lines = fs.readFileSync(ARCHIVE, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 3);
  assert.deepStrictEqual(lines, ['{"ts":5}', '{"ts":6}', '{"ts":7}']);
});

test('pruneArchive：主文件永不裁剪', () => {
  livecfg.Store({ reqlogRetention: { days: 0, maxLines: 1 } });
  fs.writeFileSync(ARCHIVE, '{"ts":1}\n{"ts":2}\n{"ts":3}\n', 'utf8');
  const main = Array.from({ length: 10 }, (_, i) => `{"ts":${i}}`).join('\n') + '\n';
  fs.writeFileSync(FILE, main, 'utf8');
  reqlog.pruneArchive();
  assert.strictEqual(fs.readFileSync(FILE, 'utf8'), main, '主文件 untouched');
});

test('pruneArchive：归档不存在时静默，不影响调用方', () => {
  assert.doesNotThrow(() => reqlog.pruneArchive());
});
