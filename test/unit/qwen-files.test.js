// test/unit/qwen-files.test.js - 千问 barn 上传的纯函数（2026-10-31）
//
// 分片公式取自客户端 `uploadBytes`：clamp(1MB, 100MB, ceil(size/10))。
const { test } = require('node:test');
const assert = require('node:assert');
const f = require('../../src/qwenwork/files');

const MB = 1024 * 1024;

test('分片大小 = clamp(1MB, 100MB, ceil(size/10))', () => {
  // 小文件一律 1MB 下限
  assert.equal(f.chunkSizeFor(0), MB);
  assert.equal(f.chunkSizeFor(12), MB);
  assert.equal(f.chunkSizeFor(10 * MB), MB);          // ceil(10MB/10)=1MB，正好下限
  // 中间区按 size/10 均分
  assert.equal(f.chunkSizeFor(20 * MB), 2 * MB);
  assert.equal(f.chunkSizeFor(100 * MB), 10 * MB);
  assert.equal(f.chunkSizeFor(500 * MB), 50 * MB);
  // 上限 100MB
  assert.equal(f.chunkSizeFor(2000 * MB), 100 * MB);
});

test('分片大小对非法输入回落到下限而不是 NaN', () => {
  for (const bad of [null, undefined, 'abc', -5, NaN]) {
    assert.equal(f.chunkSizeFor(bad), MB);
  }
});

test('barn 基址是 GATEWAY + /api（少写 /api 会 404）', () => {
  assert.equal(f.barnBase(), 'https://gateway.qwenwork.cn/api');
});

test('单文件上限与客户端一致（100MB）', () => {
  assert.equal(f.MAX_FILE_BYTES, 104857600);
  assert.equal(f.MAX_FILE_BYTES / MB, 100);
});
