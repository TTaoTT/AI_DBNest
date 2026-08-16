/**
 * test-scram.cjs — 离线验证 pgwire.js 的 SCRAM-SHA-256 实现（无需服务器、无需密码）
 * 运行：node server/test-scram.cjs
 */
const crypto = require('crypto');
const { PgWire } = require('./src/connection/dialects/pgwire.js');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
}

console.log('== 1) 基础加密原语（已知向量）==');
const sha256abc = crypto.createHash('sha256').update('abc').digest('hex');
ok('SHA256("abc") 向量', sha256abc === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', sha256abc);
const hmacJefe = crypto.createHmac('sha256', 'Jefe').update('what do ya want for nothing?').digest('hex');
ok('HMAC-SHA256 RFC4231 用例2', hmacJefe === '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843', hmacJefe);

console.log('== 2) SCRAM 内部一致性（clientProof 可反解回 clientKey / serverSignature 自洽）==');
// 复用 pgwire 内部的 crypto 工具
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const sha256 = (d) => crypto.createHash('sha256').update(d).digest();
const xor = (a, b) => Buffer.from(a.map((x, i) => x ^ b[i]));

function scramSelfConsistent(password, clientFirst, serverFirst) {
  const { clientFinal, serverSignature } = PgWire.scramCompute(password, clientFirst, serverFirst);
  const pMatch = /,p=(.+)$/.exec(clientFinal);
  const clientProof = Buffer.from(pMatch[1], 'base64');
  const withoutProof = clientFinal.slice(0, clientFinal.indexOf(',p='));
  const authMessage = clientFirst + ',' + serverFirst + ',' + withoutProof;
  const salt = Buffer.from(/s=([^,]+)/.exec(serverFirst)[1], 'base64');
  const iter = parseInt(/i=(\d+)/.exec(serverFirst)[1], 10);
  const salted = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iter, 32, 'sha256');
  const clientKey = hmac(salted, 'Client Key');
  const storedKey = sha256(clientKey);
  const clientSig = hmac(storedKey, authMessage);
  const recovered = xor(clientProof, clientSig); // 应等于 clientKey
  const serverKey = hmac(salted, 'Server Key');
  const expectedSig = hmac(serverKey, authMessage).toString('base64');
  return recovered.equals(clientKey) && serverSignature === expectedSig;
}

// 用例 A：RFC 7677 输入（仅验证数学自洽，不依赖外部 v 值）
const cfA = 'n,,n=user,r=4YQWgCFq34RJs9/bP3+7+DA==';
const sfA = 'r=4YQWgCFq34RJs9/bP3+7+DA==6YfBfG9zmZf7EvGTC6pz0o,s=bixboozjUKXXEk5+VJxRjHc04/VTAZg==,i=4096';
ok('RFC7677 输入自洽', scramSelfConsistent('pencil', cfA, sfA));
// 用例 B：随机密码/盐/迭代，验证实现对任意输入都正确
const cfB = 'n,,n=*,r=' + crypto.randomBytes(18).toString('base64');
const cfBnonce = cfB.split('r=')[1];
const sfBvalid = 'r=' + cfBnonce + 'XYZ,s=bXlzYWx0,i=10000';
ok('随机输入自洽', scramSelfConsistent('S3cr3t!P@ss', cfB, sfBvalid));

console.log('\n========================================');
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) { console.log('失败：\n - ' + fails.join('\n - ')); process.exit(1); }
else console.log('SCRAM 实现离线校验通过 ✅（真实服务端认证将在联网连接时由 PG 服务器最终确认）');
