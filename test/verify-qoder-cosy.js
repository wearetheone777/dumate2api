// test/verify-qoder-cosy.js - Qoder 签名算法的离线验证
//
// 不依赖任何运行中的服务与网络。用**参考实现（Go）生成的确定性测试向量**
// 逐字节比对，覆盖三个确定性环节：
//   - Encode  ：自定义 base64（重排 + 换字母表）
//   - aesEncrypt：AES-128-CBC + PKCS#7，IV = key[:16]
//   - signRequest / signLegacy：MD5 签名
//   - identityJson：身份 JSON 的 key 必须字母序
//
// 为什么不比对 RSA：PKCS#1 v1.5 加密是随机的（每次 padding 不同），
// 无法逐字节比对；只验证密文长度（1024 位公钥 → 128 字节）。
//
// 测试向量来自 wangtufly/QCCG 的 internal/cosy 包（GPL-3.0，仅作参考基准，
// 本仓库的实现是独立重写）。
const cosy = require('../src/qoder/cosy');
const constants = require('../src/qoder/constants');

let failures = 0;
function eq(label, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`);
  if (!ok) { console.log(`   got : ${JSON.stringify(got)}`); console.log(`   want: ${JSON.stringify(want)}`); }
}

console.log('== Encode：自定义 base64 ==');
eq('encode("")', cosy.encode(''), '');
eq('encode("a")', cosy.encode('a'), '$p$#');
eq('encode("ab")', cosy.encode('ab'), '$SB#');
eq('encode("abc")', cosy.encode('abc'), 'MSK#');
eq('encode("abcd")', cosy.encode('abcd'), '$$KMD_#S');
eq('encode(JSON)', cosy.encode('{"function":"solo_work_lite"}'), 'YP.WrPxCLBEw$*ByBEjbuHWeJ(WmYKOJSQMJHLbu');

console.log('');
console.log('== AES-128-CBC（tempKey = "0123456789abcdef"）==');
const TK = Buffer.from('0123456789abcdef');
eq('aes("")', cosy.aesEncrypt(Buffer.from(''), TK).toString('base64'), '7Uf+4FRcP6fdBw1EuG6Y2Q==');
eq('aes("hello")', cosy.aesEncrypt(Buffer.from('hello'), TK).toString('base64'), 'MOfLtxzZ0YgS4+5cPylFYw==');
eq('aes(16B 整块)', cosy.aesEncrypt(Buffer.from('0123456789abcdef'), TK).toString('base64'), 'C5sV2ktEoPUVHc/EwB811b8xuRnjiS3cO1khLWp7EeY=');
eq('aes(17B 需补位)', cosy.aesEncrypt(Buffer.from('0123456789abcdefg'), TK).toString('base64'), 'C5sV2ktEoPUVHc/EwB811XwvqWKZ4w7Jenep+UXb8QQ=');

console.log('');
console.log('== MD5 签名 ==');
eq('signRequest', cosy.signRequest('PAYLOAD', 'COSYKEY', '1234567890', 'BODY', '/api/v2/model/list'), '6c655764753fe82027200302387d2723');
eq('signLegacy', cosy.signLegacy('Mon, 02 Jan 2006 15:04:05 GMT'), '93ce95b069c6e7f6b7caec9120453615');

console.log('');
console.log('== 身份 JSON（key 必须字母序）==');
const WANT_JSON = '{"aid":"aid-123","name":"tester","organization_id":"org-abc","organization_name":"Org Name","refresh_token":"refresh-token-abc","security_oauth_token":"sec-token-xyz","uid":"uid-456","user_type":"personal","yx_uid":"yx-789"}';
const id = {
  name: 'tester', aid: 'aid-123', uid: 'uid-456', yxUid: 'yx-789',
  organizationId: 'org-abc', organizationName: 'Org Name', userType: 'personal',
  securityOauthToken: 'sec-token-xyz', refreshToken: 'refresh-token-abc',
};
eq('identityJson 字段序', cosy.identityJson(id), WANT_JSON);
eq('info = AES(identityJson)', cosy.aesEncrypt(Buffer.from(cosy.identityJson(id)), TK).toString('base64'),
  '0yulLQYVrsqi+WDjcKyJcjxvSa17EYVEC4S+vAy7nyCnBPAX2gXzOEfkhQfW3vulYrJGu6qvgxMZ5UT1Vta+9BsDJrVHXR1htAqjnBD//P2lWjHnFWXuhBQqZy/M/F23iDets0sln+97sYlPgglKamMxbSRf/n6ZO93KbHKOiUS8f+xAAOH0pLMPFjiYTgI3ZFZe//9gaG92zW/ozNMg0nGZ9UP+oDAyDcXLYa0IV8XWQhfWXhny2DnOtNJN/Im6h6LBvv4BTvGTCsJ1MNxRxGztMn62DPh38m5htv3w4ixHWimKjvCVqCbS0kBvpPIt');

console.log('');
console.log('== 结构 ==');
const pb = cosy.buildPayloadB64('INFO_X');
const pbObj = JSON.parse(Buffer.from(pb, 'base64').toString());
eq('payload key 顺序', Object.keys(pbObj).join(','), 'cosyVersion,ideVersion,info,requestId,version');
// 版本断言跟随常量：这里验证的是「cosyVersion 透传进 payload」这个行为，
// 不是钉死具体值（默认值 2026-10-30 从桌面端 1.0.10 对齐到官方 CLI 的 1.1.75，
// 可被 DUMATE_QODER_COSY_VERSION 覆盖）。
eq('payload cosyVersion', pbObj.cosyVersion, constants.COSY_VERSION);
eq('payload ideVersion 为空', pbObj.ideVersion, '');
eq('payload version', pbObj.version, 'v1');
eq('bearer 形状', cosy.composeBearer('PB', 'SIG'), 'Bearer COSY.PB.SIG');

console.log('');
console.log('== RSA（只验证长度，padding 随机无法逐字节比对）==');
eq('rsa 密文 128 字节', cosy.rsaEncrypt(TK).length, 128);

console.log('');
console.log('== 会话构造 ==');
const sess = cosy.newSession(id, 'mid-1', 'mtok-1', '5');
eq('cosyKey 是 base64(128B)', Buffer.from(sess.cosyKey, 'base64').length, 128);
eq('info 非空', sess.info.length > 0, true);
eq('machineId 透传', sess.machineId, 'mid-1');
const h = cosy.buildHeaders(sess, '/api/v2/model/list', '', 'application/json', {});
eq('Authorization 前缀', h.authorization.slice(0, 12), 'Bearer COSY.');
eq('cosy-clienttype', h['cosy-clienttype'], '5');
eq('cosy-user', h['cosy-user'], 'uid-456');
eq('带 cosy-key', !!h['cosy-key'], true);

console.log('');
if (failures) { console.log(`${failures} 项失败`); process.exit(1); }
console.log('全部通过');
process.exit(0);
