// 验证：cosy.encode 必须保持逐字节正确，**且**是 O(n)。
//
// 为什么单独验证性能：原实现 `let out=''; for(...) out += mapped;` 在 V8 里是
// 近似 O(n²) 的字符串拼接，叠上 `std.slice()` 三段重排的临时字符串，实测
// 64MB 要 15.2s、128MB 直接 4GB heap OOM 崩溃。而 `encode` 是**同步**的
// （在 qoder/index.js 的 runOnce 里直接调），它一慢就**阻塞整个事件循环**：
// /health 也不响应、其他通道请求全部排队，客户端表现为「一直转圈、没有任何
// 输出」，网关 CPU 跑满却不崩——2026-10-03 实际发生过，极难自查。
//
// 所以本测试锁两条：
//   1. 与「朴素实现」逐字节一致（正确性，含固定测试向量）
//   2. 每 KB 成本不随输入增大而上升（线性，防 O(n²) 回归）
//
// 不依赖任何运行中的服务，不打上游。
const crypto = require('crypto');
const cosy = require('../src/qoder/cosy');

const results = [];
const assert = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${ok ? '' : '  ← ' + (detail || '')}`);
};

// ---- 朴素参考实现（与原实现逐字一致）----
const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CUSTOM_PAD = '$';
const S2C = {};
for (let i = 0; i < 64; i++) S2C[STD_ALPHABET[i]] = CUSTOM_ALPHABET[i];
S2C['='] = CUSTOM_PAD;
function naiveEncode(plaintext) {
  const std = Buffer.from(plaintext).toString('base64');
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = '';
  for (let i = 0; i < n; i++) out += S2C[rearranged[i]];
  return out;
}

// ---- 1. 正确性：固定向量 ----
assert('encode("") === ""', cosy.encode('') === '');
assert('encode("a") === "$p$#"', cosy.encode('a') === '$p$#', cosy.encode('a'));
assert('encode("ab") === "$SB#"', cosy.encode('ab') === '$SB#', cosy.encode('ab'));
assert('encode("abc") === "MSK#"', cosy.encode('abc') === 'MSK#', cosy.encode('abc'));
assert('encode("abcd") === "$$KMD_#S"', cosy.encode('abcd') === '$$KMD_#S', cosy.encode('abcd'));
assert('encode(JSON) 与参考一致',
  cosy.encode('{"function":"solo_work_lite"}') === 'YP.WrPxCLBEw$*ByBEjbuHWeJ(WmYKOJSQMJHLbu');

// ---- 2. 正确性：与朴素实现穷举比对 ----
{
  let bad = 0;
  let n = 0;
  // 覆盖长度 0..400 × 5 种填充（含 NUL / 0xFF / 非 ASCII 边界）
  for (let len = 0; len <= 400; len++) {
    for (const fill of [0x41, 0x00, 0xff, 0x7f, 0x80]) {
      const buf = Buffer.alloc(len, fill);
      n++;
      if (naiveEncode(buf) !== cosy.encode(buf)) bad++;
    }
  }
  // 随机字节（含跨 3 字节分组的边界）
  for (let k = 0; k < 200; k++) {
    const buf = crypto.randomBytes(Math.floor(Math.random() * 5000));
    n++;
    if (naiveEncode(buf) !== cosy.encode(buf)) bad++;
  }
  assert(`与朴素实现逐字节一致（${n} 组）`, bad === 0, `${bad} 组不一致`);
}

// ---- 3. 性能：每 KB 成本必须恒定（防 O(n²) 回归）----
//
// **测量纪律（2026-11-08 修偶发假失败）**：原来每个尺寸只测**一次**——
// 16MB 那次一旦撞上 GC（分配 16MB 本身就容易触发），耗时会被整段 GC 撑大，
// 比值随机越过阈值 3，表现为「性能用例偶发变红」。而它要防的是**数量级**
// 回归（O(n²) 会超 10 倍），不是几个百分点的抖动，所以：
//   1. 先跑一遍预热（让编码路径完成 JIT，1MB 的首次调用明显偏慢）
//   2. 每个尺寸测 3 次取**最小值**（min-of-N 是基准测试的标准做法：
//      噪声只会让某次变慢，不会让某次变快，取最小就是对噪声免疫）
// 阈值不动（仍是 3）——判据不放松，只是把噪声从测量里去掉。
{
  const sizes = [1, 4, 16]; // MB
  const bufs = sizes.map((mb) => Buffer.alloc(mb * 1024 * 1024, 0x41));
  // 预热：小尺寸跑两次（JIT + 首次分配）
  cosy.encode(bufs[0]);
  cosy.encode(bufs[0]);
  const perKB = [];
  for (let i = 0; i < sizes.length; i++) {
    const mb = sizes[i];
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const t = process.hrtime.bigint();
      cosy.encode(bufs[i]);
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      if (ms < best) best = ms;
    }
    perKB.push(best / (mb * 1024));
  }
  // 线性实现：大输入的每 KB 成本不应明显高于小输入（放宽到 3 倍，
  // 容忍 JIT 预热与 GC 抖动；O(n²) 实现会超出 10 倍以上）
  const ratio = perKB[perKB.length - 1] / perKB[0];
  assert(`每 KB 成本不随规模上升（1→16MB 比值 ${ratio.toFixed(2)}，阈值 3）`,
    ratio < 3, `比值 ${ratio.toFixed(2)} —— 疑似 O(n²) 回归`);
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
