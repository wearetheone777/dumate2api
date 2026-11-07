// src/config-restore.js - 配置备份恢复（调研 P1-8）
//
// /system/backup 已能导出配置类 JSON（keys / admin-users / model-map 等）。
// 这里补回写：恢复前先把**当前**配置打成带时间戳的备份，再逐文件原子写。
//
// 三条纪律：
//   1. 只认备份端点声明的 CONFIG_FILES 白名单——上传任意文件名等于任意
//      文件写入；账本 jsonl、会话密钥、账号凭证一律不在这个入口恢复。
//   2. 校验每个值是对象/数组（配置文件的既有形状）；非法整包拒掉，
//      不做「跳过坏文件继续写」的半恢复（半套配置比不恢复更难排查）。
//   3. 备份文件含 key 明文与口令哈希，落 0600 + 目录权限收紧；
//      响应只回文件名/数量，不回显任何配置内容。
const fs = require('fs');
const path = require('path');
const { DATA_DIR, ensureDir, readJSON, writeJSON } = require('./admin/store');
const fileperm = require('./fileperm');

const CONFIG_FILES = ['model-map.json', 'keepalive.json', 'notify.json', 'keys.json', 'hot-config.json', 'admin-users.json'];
const BACKUP_KEEP = 10;

function backupDir() { return path.join(DATA_DIR, 'config-backup'); }

/** 校验整包：只收白名单对象，且必须至少有一个可恢复文件 */
function validate(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: '备份体必须是对象' };
  const config = payload.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { ok: false, error: '缺少 config 对象' };
  const names = [];
  for (const name of Object.keys(config)) {
    if (!CONFIG_FILES.includes(name)) return { ok: false, error: `配置白名单外文件: ${name}` };
    const v = config[name];
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: `${name} 不是配置对象` };
    if (v.__error) return { ok: false, error: `${name} 的导出含读取错误：${v.__error}` };
    names.push(name);
  }
  if (!names.length) return { ok: false, error: 'config 里没有可恢复的配置文件' };
  return { ok: true, names, config };
}

function backupCurrent(names) {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `config-backup-${stamp}.json`);
  const snap = {};
  for (const name of names) snap[name] = readJSON(name, null);
  fs.writeFileSync(file, JSON.stringify({ at: Date.now(), config: snap }, null, 2), { mode: 0o600, encoding: 'utf8' });
  fileperm.harden(file);
  // 只保留最近 N 份：备份目录无限增长会把 data/ 撑大
  const files = fs.readdirSync(dir).filter((f) => /^config-backup-.*\.json$/.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
    try { fs.unlinkSync(path.join(dir, old)); } catch (e) { /* 删不掉不影响恢复 */ }
  }
  return path.basename(file);
}

function restore(payload) {
  const v = validate(payload);
  if (!v.ok) return { ok: false, error: v.error };
  ensureDir();
  const backup = backupCurrent(v.names);
  const restored = [];
  for (const name of v.names) {
    writeJSON(name, v.config[name]);   // 原子写 + 权限收紧
    restored.push(name);
  }
  return { ok: true, restored, backup, at: Date.now() };
}

module.exports = { CONFIG_FILES, BACKUP_KEEP, validate, backupCurrent, restore, backupDir };
