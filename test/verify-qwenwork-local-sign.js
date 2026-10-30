// 验证：千问办公的**纯本地签名**（不需要 wasm、不需要客户端）。
//
// 背景（2026-10-14）：
//   用户卸载千问办公客户端后 wasm 文件随之消失，通道直接变成 ready=false
//   （原实现只有 wasm 一条签名路径）。而千问与 Qoder 是**同一套 COSY 协议栈**
//   ——同一个 client_id、同一个聊天路径、同一套 Encode=1 自定义 base64、
//   连服务端公钥都是同一把——Qoder 的签名算法是纯本地的且逐字节验证过。
//   实测用同一套算法给千问签名，gateway.qwenwork.cn 返回 200 并正常出流。
//
// 本测试锁定这条路径的契约，全部离线（不打网络）：
//   · prepareInfer 的输入输出形状与 bridge 契约一致
//   · url / body / headers 的关键字段
//   · 签名可用同一套算法独立重算（证明不是「看起来对」）
//   · 每次请求的 requestId 必须新（否则上游可能去重）
//   · 算法本体只有一份（qoder 与 qwenwork 共用，防止复制后漂移）
//   · bridge 的 local/wasm 开关与 status() 的就绪判定
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const core = require(path.join(ROOT, 'src/cosy'));
const qoderCosy = require(path.join(ROOT, 'src/qoder/cosy'));
const sign = require(path.join(ROOT, 'src/qwenwork/cosy-sign'));
const constants = require(path.join(ROOT, 'src/qwenwork/constants'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); console.log(`[PASS] ${name}`); }
  catch (e) { results.push({ name, ok: false, err: e.message }); console.log(`[FAIL] ${name}  ← ${e.message}`); }
}

const FAKE = {
  uid: 'f74ec609-c0d7-4f6e-a279-f07e57581e14',
  token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake-token-for-test',
  bodyJson: JSON.stringify({ request_id: 'r1', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  modelKey: 'flash',
  machineId: '008568ed-f3f5-47aa-9c33-6d3c9f2b1a44',
};

// ---- 1. 契约：返回 {url, body, headers} ----
let built;
check('prepareInfer 返回 {url, body, headers}', () => {
  built = sign.prepareInfer(FAKE);
  assert.ok(built && typeof built.url === 'string', 'url 缺失');
  assert.ok(typeof built.body === 'string' && built.body.length > 0, 'body 缺失');
  assert.ok(built.headers && typeof built.headers === 'object', 'headers 缺失');
});

// ---- 2. url 必须与 wasm 版本一致（网关 + 路径 + query）----
check('url 指向千问网关的正确路径与 query', () => {
  const expect = constants.GATEWAY + constants.CHAT_PATH + '?' + constants.CHAT_QUERY;
  assert.strictEqual(built.url, expect);
  assert.ok(built.url.startsWith('https://gateway.qwenwork.cn/algo/api/v2/service/pro/sse/agent_chat_generation?'), '路径不对');
  assert.ok(built.url.includes('Encode=1'), '缺 Encode=1（1.1.0 起要求，缺了会 400）');
  assert.ok(built.url.includes('AgentId=agent_common'), '缺 AgentId');
});

// ---- 3. body 必须是 Encode 过的（不是明文 JSON）----
check('body 是 Encode 编码（非明文 JSON）', () => {
  assert.ok(!built.body.startsWith('{'), 'body 是明文——没有被 Encode');
  // Encode 的自定义字母表里没有标准 base64 的 '+' 与 '/'，用它做粗判
  assert.ok(!built.body.includes('+'), 'body 里出现标准 base64 字符 +');
  // 长度关系：base64 会把长度放大到 4/3 向上取整
  const expectedMin = Math.ceil(FAKE.bodyJson.length / 3) * 4;
  assert.ok(built.body.length >= expectedMin - 4, `body 长度 ${built.body.length} 与明文 ${FAKE.bodyJson.length} 不成比例`);
});

// ---- 4. headers 关键字段 ----
check('headers 带 Authorization: Bearer COSY.<payload>.<sig> 三段式', () => {
  const auth = built.headers.authorization;
  assert.ok(typeof auth === 'string', 'authorization 缺失');
  // 整体形状：前缀 + 标准 base64 的 payload + 32 位 md5 hex 的签名
  assert.ok(
    /^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/.test(auth),
    `形状不对: ${auth.slice(0, 40)}…`,
  );
  const rest = auth.slice('Bearer COSY.'.length);
  assert.strictEqual(rest.split('.').length, 2, 'payload 与 sig 两段（payload 是标准 base64，不含点）');
  assert.strictEqual(rest.split('.').pop().length, 32, 'sig 应是 32 位 md5 hex');
});

check('headers 的 cosy-version / clienttype / scene 取自 constants', () => {
  assert.strictEqual(built.headers['cosy-version'], constants.COSY_VERSION);
  assert.strictEqual(built.headers['cosy-clienttype'], constants.CLIENT_TYPE);
  assert.strictEqual(built.headers['cosy-scene'], constants.SCENE);
  assert.strictEqual(built.headers['cosy-business-product'], constants.BUSINESS_PRODUCT);
  assert.strictEqual(built.headers['user-agent'], constants.USER_AGENT);
});

check('headers 带模型选择（x-model-key，只设 body 时上游仍走 auto）', () => {
  assert.strictEqual(built.headers['x-model-key'], FAKE.modelKey);
  assert.strictEqual(built.headers['x-model-source'], 'system');
});

// ---- 5. 签名必须能被独立重算（证明不是「看起来对」）----
check('签名可用同一套算法独立重算', () => {
  const auth = built.headers.authorization;
  const payloadB64 = auth.slice('Bearer COSY.'.length).split('.')[0];
  const sig = auth.split('.').pop();
  const recomputed = core.signRequest(
    payloadB64, built.headers['cosy-key'], built.headers['cosy-date'], built.body, sign.CHAT_PATH_SIG,
  );
  assert.strictEqual(sig, recomputed, '重算的签名与 header 里的不一致');
});

check('pathSig 是去掉 /algo 前缀的聊天路径', () => {
  assert.strictEqual(sign.CHAT_PATH_SIG, '/api/v2/service/pro/sse/agent_chat_generation');
  assert.ok(!sign.CHAT_PATH_SIG.startsWith('/algo'), 'pathSig 不该带 /algo');
});

check('payload 里带 cosyVersion 与 requestId', () => {
  const auth = built.headers.authorization;
  const payloadB64 = auth.slice('Bearer COSY.'.length).split('.')[0];
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
  assert.strictEqual(payload.cosyVersion, constants.COSY_VERSION);
  assert.ok(payload.requestId && payload.requestId.length >= 32, 'requestId 缺失或过短');
  assert.ok(payload.info && payload.info.length > 100, 'info（AES 加密的身份）缺失');
  assert.strictEqual(payload.version, 'v1');
});

// ---- 6. 每次请求的 requestId / 密钥必须新 ----
check('两次调用产生不同的 requestId 与 cosy-key（不复用会话）', () => {
  const a = sign.prepareInfer(FAKE);
  const b = sign.prepareInfer(FAKE);
  const getPayload = (x) => JSON.parse(Buffer.from(x.headers.authorization.slice('Bearer COSY.'.length).split('.')[0], 'base64').toString('utf8'));
  assert.notStrictEqual(getPayload(a).requestId, getPayload(b).requestId, 'requestId 重复');
  assert.notStrictEqual(a.headers['cosy-key'], b.headers['cosy-key'], 'cosy-key 重复（临时密钥没重新生成）');
});

// ---- 7. 身份 JSON 的字段顺序（字母序，Go 的 map 序列化口径）----
check('身份 JSON 的 key 是字母序（顺序错则签名对不上）', () => {
  const json = sign.identityJson({ uid: 'u1', token: 't1' });
  const keys = Object.keys(JSON.parse(json));
  const sorted = keys.slice().sort();
  assert.deepStrictEqual(keys, sorted, `实际顺序 ${keys.join(',')} 不是字母序`);
  const obj = JSON.parse(json);
  assert.strictEqual(obj.data_policy_agreed, true);
  assert.strictEqual(obj.uid, 'u1');
  assert.strictEqual(obj.security_oauth_token, 't1');
});

// ---- 8. 算法本体只有一份（防止复制后漂移）----
check('qoder/cosy.js 与 src/cosy.js 共用同一份算法实现', () => {
  assert.strictEqual(qoderCosy.encode, core.encode, 'encode 不是同一个函数');
  assert.strictEqual(qoderCosy.rsaEncrypt, core.rsaEncrypt, 'rsaEncrypt 不是同一个函数');
  assert.strictEqual(qoderCosy.aesEncrypt, core.aesEncrypt, 'aesEncrypt 不是同一个函数');
  assert.strictEqual(qoderCosy.SERVER_PUBKEY_PEM, core.SERVER_PUBKEY_PEM, '公钥不是同一份');
});

check('两个通道的 cosyVersion 各自独立（千问 1.1.52 / Qoder 1.1.75）', () => {
  const qoderPayload = JSON.parse(Buffer.from(
    qoderCosy.buildPayloadB64('dummy-info'), 'base64',
  ).toString('utf8'));
  const qwPayload = JSON.parse(Buffer.from(
    built.headers.authorization.slice('Bearer COSY.'.length).split('.')[0], 'base64',
  ).toString('utf8'));
  assert.strictEqual(qwPayload.cosyVersion, '1.1.52', '千问的 cosyVersion 应为 1.1.52');
  assert.strictEqual(qoderPayload.cosyVersion, '1.1.75', 'Qoder 的 cosyVersion 应为 1.1.75（5d6f271 对齐官方 CLI）');
});

// ---- 9. bridge 的开关与 status() 判定 ----
check('bridge 默认走 local，DUMATE_QWENWORK_USE_WASM=1 才切 wasm', () => {
  const bridgePath = require.resolve(path.join(ROOT, 'src/qwenwork/bridge'));
  delete require.cache[bridgePath];
  const bridge = require(bridgePath);
  const saved = process.env.DUMATE_QWENWORK_USE_WASM;

  delete process.env.DUMATE_QWENWORK_USE_WASM;
  assert.strictEqual(bridge.signer(), 'local', '默认应为 local');
  assert.strictEqual(bridge.useWasm(), false);

  process.env.DUMATE_QWENWORK_USE_WASM = '1';
  assert.strictEqual(bridge.signer(), 'wasm', '设为 1 后应为 wasm');
  assert.strictEqual(bridge.useWasm(), true);

  if (saved === undefined) delete process.env.DUMATE_QWENWORK_USE_WASM;
  else process.env.DUMATE_QWENWORK_USE_WASM = saved;
});

check('本地签名模式下 warmup 不依赖 wasm 文件（不抛错）', () => {
  const bridgePath = require.resolve(path.join(ROOT, 'src/qwenwork/bridge'));
  delete require.cache[bridgePath];
  const bridge = require(bridgePath);
  const saved = process.env.DUMATE_QWENWORK_USE_WASM;
  delete process.env.DUMATE_QWENWORK_USE_WASM;
  const r = bridge.warmup(); // 本机没有 wasm 文件；本地模式必须照样成功
  assert.ok(r && r.version === 'local', `warmup 返回值异常: ${JSON.stringify(r)}`);
  if (saved === undefined) delete process.env.DUMATE_QWENWORK_USE_WASM;
  else process.env.DUMATE_QWENWORK_USE_WASM = saved;
});

// ---- 10. 与 Qoder 的请求形状同构（同一协议栈的直接证据）----
check('千问与 Qoder 的 header 集合同构（仅身份取值不同）', () => {
  const qoderKeys = ['cosy-data-policy', 'content-type', 'cosy-clienttype', 'cosy-date', 'cosy-user',
    'cosy-key', 'cache-control', 'authorization', 'cosy-version', 'login-version', 'user-agent'];
  for (const k of qoderKeys) {
    assert.ok(k in built.headers, `千问 headers 缺少 ${k}——与 Qoder 不再同构`);
  }
  // 差异项：千问不带 machinetype/machinetoken（wasm 的 clientMetadata 里没有它们）
  assert.ok(!('cosy-machinetype' in built.headers), '千问不该带 cosy-machinetype');
});

const pass = results.filter((x) => x.ok).length;
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
