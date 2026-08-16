/**
 * pgwire.js — 零依赖的纯 Node.js PostgreSQL 客户端（CommonJS）
 *
 * 用途：在无法 `npm install pg` 的受限环境里，让后端真实数据路径直连 PostgreSQL。
 * 同时被后端 postgres.ts 适配器与端到端测试直接 require 使用。
 *
 * 实现：PostgreSQL v3 前端/后端协议（TCP，无 SSL），支持 SCRAM-SHA-256 认证
 *       （本地 pg_hba.conf 默认为 scram-sha-256）。覆盖：启动、认证、简单查询、
 *       行描述、数据行、命令完成、参数状态、错误响应。
 *
 * 不覆盖：二进制格式、COPY、大对象、事务协议扩展（足够驱动管理工具的数据路径）。
 */
'use strict';
const net = require('net');
const crypto = require('crypto');

const TYPE_NAMES = {
  16: 'bool', 17: 'bytea', 18: 'char', 19: 'name', 20: 'int8', 21: 'int2',
  23: 'int4', 25: 'text', 26: 'oid', 700: 'float4', 701: 'float8',
  1042: 'bpchar', 1043: 'varchar', 1082: 'date', 1083: 'time',
  1114: 'timestamp', 1184: 'timestamptz', 1186: 'interval',
  1700: 'numeric', 2950: 'uuid', 114: 'json', 3802: 'jsonb',
  2951: 'txid', 703: 'oid', 829: 'macaddr',
};

function typeName(oid) {
  return TYPE_NAMES[oid] || 'oid:' + oid;
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}
function xor(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}
function readCStr(buf, off) {
  const end = buf.indexOf(0, off);
  const raw = buf.slice(off, end < 0 ? buf.length : end);
  // PG 服务器(中文 Windows locale)错误消息常为 GBK/GB18030,UTF-8 解码出 U+FFFD → 智能回退
  const s = raw.toString('utf8');
  if (!s.includes('\uFFFD')) return s;
  try { return new TextDecoder('gb18030').decode(raw); } catch (_) { return s; }
}
function bufInt16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n, 0); return b; }
function bufInt32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; }

class PgWire {
  constructor(opts) {
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port || 5432;
    this.user = opts.user || 'postgres';
    this.password = opts.password || '';
    this.database = opts.database || this.user;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.queue = [];
    this.waiters = [];
    this.err = null;
    this.connected = false;
    this.lastFields = [];
  }

  // ---- 底层消息收发 ----
  _send(body) {
    const len = Buffer.alloc(4);
    len.writeInt32BE(body.length + 4, 0);
    this.socket.write(Buffer.concat([len, body]));
  }
  _sendTyped(type, body) {
    const len = Buffer.alloc(4);
    len.writeInt32BE(body.length + 4, 0); // 长度含自身，不含 type 字节
    const header = Buffer.from([type.charCodeAt(0)]);
    this.socket.write(Buffer.concat([header, len, body]));
  }
  _push(msg) {
    if (this.waiters.length) this.waiters.shift()(msg);
    else this.queue.push(msg);
  }
  next() {
    if (this.err) return Promise.reject(this.err);
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((res) => this.waiters.push(res));
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    // 解析所有完整消息
    while (true) {
      if (this.buf.length < 5) return;
      const type = this.buf[0];
      const len = this.buf.readInt32BE(1); // 含 length 字段本身，不含 type
      const total = 1 + len;
      if (this.buf.length < total) return;
      const body = this.buf.subarray(5, total);
      this.buf = this.buf.subarray(total);
      this._push({ type: String.fromCharCode(type), body });
    }
  }

  // ---- SCRAM-SHA-256 客户端计算（可被 RFC 5802 向量离线自测）----
  static scramClientFirst() {
    const nonce = crypto.randomBytes(18).toString('base64');
    const clientFirst = 'n,,n=*,r=' + nonce;
    return { nonce, clientFirst };
  }
  static scramCompute(password, clientFirst, serverFirst) {
    const m = /^r=([^,]+),s=([^,]+),i=(\d+)$/.exec(serverFirst);
    if (!m) throw new Error('无法解析 SCRAM 服务端首消息: ' + serverFirst);
    const serverNonce = m[1];
    const salt = Buffer.from(m[2], 'base64');
    const iter = parseInt(m[3], 10);
    const clientFinalWithoutProof = 'c=biws,r=' + serverNonce; // biws = base64("n,,")
    const saltedPassword = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iter, 32, 'sha256');
    const clientKey = hmac(saltedPassword, 'Client Key');
    const storedKey = sha256(clientKey);
    // RFC 5802：authMessage 使用「不含 gs2-header 的 client-first-message-bare」
    const bare = clientFirst.replace(/^[^,]*,,/, '');
    const authMessage = bare + ',' + serverFirst + ',' + clientFinalWithoutProof;
    const clientSignature = hmac(storedKey, authMessage);
    const clientProof = xor(clientKey, clientSignature);
    const clientFinal = clientFinalWithoutProof + ',p=' + clientProof.toString('base64');
    const serverSignature = hmac(hmac(saltedPassword, 'Server Key'), authMessage);
    return { clientFinal, serverSignature: serverSignature.toString('base64'), serverNonce };
  }

  // ---- 连接 + 认证 ----
  connect() {
    return new Promise((resolve, reject) => {
      this.err = null;
      const sock = net.createConnection({ host: this.host, port: this.port, timeout: 10000 });
      this.socket = sock;
      sock.setTimeout(10000);
      sock.on('timeout', () => {
        const e = new Error('连接超时');
        this.err = e;
        sock.destroy();
        reject(e);
      });
      sock.on('error', (e) => {
        this.err = e;
        reject(e);
      });
      sock.on('data', (chunk) => this._onData(chunk));

      // 发送 StartupMessage（无 type 字节）
      const kv = Buffer.concat([
        Buffer.from('user'), Buffer.from([0]), Buffer.from(this.user), Buffer.from([0]),
        Buffer.from('database'), Buffer.from([0]), Buffer.from(this.database), Buffer.from([0]),
        Buffer.from('client_encoding'), Buffer.from([0]), Buffer.from('UTF8'), Buffer.from([0]),
        Buffer.from('application_name'), Buffer.from([0]), Buffer.from('dbadmin'), Buffer.from([0]),
        Buffer.from([0]),
      ]);
      const proto = Buffer.alloc(4);
      proto.writeInt32BE(196608, 0); // 3.0
      const msg = Buffer.concat([proto, kv]);
      const len = Buffer.alloc(4);
      len.writeInt32BE(msg.length + 4, 0);
      sock.write(Buffer.concat([len, msg]));

      this._authLoop().then(resolve).catch(reject);
    });
  }

  async _authLoop() {
    // 读取认证消息直到 ReadyForQuery
    for (;;) {
      const msg = await this.next();
      if (msg.type === 'E') throw new Error(parseError(msg.body));
      if (msg.type === 'S' || msg.type === 'K') continue; // ParameterStatus / BackendKeyData
      if (msg.type === 'Z') {
        this.connected = true;
        // 禁用空闲超时：慢查询执行期间 socket 长时间无数据回流，10s 空闲超时会误杀连接
        this.socket.setTimeout(0);
        // TCP keepalive：防止中间设备/NAT 因空闲回收连接（连接"经常断掉"的主因之一）
        try { this.socket.setKeepAlive(true, 30000); } catch (_) {}
        return;
      }
      if (msg.type !== 'R') continue; // 其它未知边消息忽略
      const code = msg.body.readInt32BE(0);
      if (code === 0) continue; // AuthOk
      if (code === 10) {
        // SASL：解析机制列表，发送 SCRAM 初始响应
        if (process.env.DEBUG_PGW) console.error('DEBUG SASL bodyLen=%d fullhex=%s', msg.body.length, msg.body.toString('hex'));
        // 解析机制列表：部分 PG 服务端在 AuthRequestSASL 中省略显式机制计数，
        // 以 C 字符串列表 + 空字符串（双 \0）结尾。这里按「读到空串为止」稳健解析。
        let p = 4;
        const mechs = [];
        while (p < msg.body.length) {
          const s = readCStr(msg.body, p);
          if (s === '') break;
          mechs.push(s);
          p = msg.body.indexOf(0, p) + 1;
          if (p <= 0) break;
        }
        if (!mechs.length && msg.body.length > 4) {
          // 退化：若 body[4..] 直接是机制串（无计数、无结束空串）
          mechs.push(readCStr(msg.body, 4));
        }
        const n = mechs.length;
        if (!mechs.includes('SCRAM-SHA-256')) throw new Error('服务端不支持 SCRAM-SHA-256: ' + mechs.join(','));
        const { clientFirst } = PgWire.scramClientFirst();
        this._clientFirst = clientFirst;
        const mech = Buffer.from('SCRAM-SHA-256' + '\0', 'utf8');
        const cf = Buffer.from(clientFirst, 'utf8');
        const cfLen = Buffer.alloc(4);
        cfLen.writeInt32BE(cf.length, 0);
        this._sendTyped('p', Buffer.concat([mech, cfLen, cf]));
        continue;
      }
      if (code === 11) {
        // SASLContinue：server-first-message
        const serverFirst = msg.body.toString('utf8', 4);
        const { clientFinal, serverSignature } = PgWire.scramCompute(this.password, this._clientFirst, serverFirst);
        this._expectSig = serverSignature;
        if (process.env.DEBUG_PGW) {
          const cNonce = /r=([^,]+)/.exec(this._clientFirst)[1];
          const sNonce = /r=([^,]+)/.exec(serverFirst)[1];
          console.error('DEBUG clientFirst=%s\nDEBUG serverNonce=%s\nDEBUG sNonce startsWith cNonce: %s', this._clientFirst, sNonce, sNonce.startsWith(cNonce));
          console.error('DEBUG clientFinal=%s', clientFinal);
        }
        this._sendTyped('p', Buffer.from(clientFinal, 'utf8'));
        continue;
      }
      if (code === 12) {
        // SASLFinal：校验服务端签名
        const serverFinal = msg.body.toString('utf8', 4);
        const v = /v=([^,]+)/.exec(serverFinal);
        if (!v) throw new Error('SCRAM 服务端最终消息格式错误: ' + serverFinal);
        if (v[1] !== this._expectSig) throw new Error('SCRAM 服务端签名校验失败');
        continue;
      }
      throw new Error('不支持的认证方式 code=' + code);
    }
  }

  // ---- 简单查询 ----
  query(sql) {
    if (!this.connected) return Promise.reject(new Error('未连接'));
    return new Promise((resolve, reject) => {
      const fields = [];
      const rows = [];
      let command = '';
      // 简单查询协议：查询串必须以 NUL 终止（否则服务端会越界读到后续字节，报无效编码）
      this._sendTyped('Q', Buffer.concat([Buffer.from(sql, 'utf8'), Buffer.from([0])]));
      const loop = async () => {
        for (;;) {
          const msg = await this.next();
          if (msg.type === 'E') return reject(new Error(parseError(msg.body)));
          if (msg.type === 'I') continue; // EmptyQueryResponse
          if (msg.type === 'N') continue; // NoticeResponse
          if (msg.type === 'T') {
            fields.length = 0;
            let off = 0;
            const cnt = msg.body.readInt16BE(off);
            off += 2;
            for (let i = 0; i < cnt; i++) {
              const name = readCStr(msg.body, off);
              off += name.length + 1;
              off += 4; // tableOid
              off += 2; // colAttr
              const oid = msg.body.readInt32BE(off);
              off += 4;
              off += 2; // typeLen
              off += 4; // typeMod
              off += 2; // fmt
              fields.push({ name, type: typeName(oid) });
            }
            continue;
          }
          if (msg.type === 'D') {
            let off = 0;
            const cnt = msg.body.readInt16BE(off);
            off += 2;
            const row = {};
            for (let i = 0; i < cnt; i++) {
              const len = msg.body.readInt32BE(off);
              off += 4;
              if (len === -1) row[fields[i].name] = null;
              else {
                row[fields[i].name] = msg.body.toString('utf8', off, off + len);
                off += len;
              }
            }
            rows.push(row);
            continue;
          }
          if (msg.type === 'C') {
            command = readCStr(msg.body, 0);
            continue;
          }
          if (msg.type === 'Z') {
            const rowCount = parseRowCount(command);
            return resolve({ fields, rows, rowCount, command });
          }
          // 其它边消息忽略
        }
      };
      loop().catch(reject);
    });
  }

  // ---- 扩展查询协议（参数化，防 SQL 注入）：Parse / Bind / Execute / Sync ----
  queryParams(sql, params) {
    if (!this.connected) return Promise.reject(new Error('未连接'));
    params = params || [];
    return new Promise((resolve, reject) => {
      const fields = [];
      const rows = [];
      let command = '';
      let rowCount = 0;
      const bindParts = [
        Buffer.from([0]), // portal
        Buffer.from([0]), // statement
        bufInt16(0), // 参数格式码数量=0（全部文本）
        bufInt16(params.length),
      ];
      for (const p of params) {
        if (p === null || p === undefined) {
          bindParts.push(bufInt32(-1)); // NULL
        } else {
          const b = Buffer.from(String(p), 'utf8');
          bindParts.push(bufInt32(b.length));
          bindParts.push(b);
        }
      }
      bindParts.push(bufInt16(0)); // 结果格式码数量=0（全部文本）
      this._sendTyped('P', Buffer.concat([Buffer.from([0]), Buffer.from(sql + '\0', 'utf8'), bufInt16(0)]));
      this._sendTyped('B', Buffer.concat(bindParts));
      // Describe(portal) —— 关键：扩展协议下 RowDescription('T') 只在响应 Describe 时下发，
      // 否则 Execute 直接吐 DataRow 而无字段元数据，导致解析字段名失败。
      this._sendTyped('D', Buffer.concat([Buffer.from([0x50]), Buffer.from([0])]));
      this._sendTyped('E', Buffer.concat([Buffer.from([0]), bufInt32(0)]));
      this._sendTyped('S', Buffer.alloc(0));
      const loop = async () => {
        for (;;) {
          const msg = await this.next();
          if (msg.type === 'E') return reject(new Error(parseError(msg.body)));
          if (msg.type === 'I') continue; // EmptyQueryResponse
          if (msg.type === 'N') continue; // NoticeResponse
          if (msg.type === '1' || msg.type === '2' || msg.type === '3' || msg.type === 'A') continue; // ParseComplete/BindComplete/CloseComplete/Notification
          if (msg.type === 'T') {
            fields.length = 0;
            let off = 0;
            const cnt = msg.body.readInt16BE(off); off += 2;
            for (let i = 0; i < cnt; i++) {
              const name = readCStr(msg.body, off); off += name.length + 1;
              off += 4; // tableOid
              off += 2; // colAttr
              const oid = msg.body.readInt32BE(off); off += 4;
              off += 2; // typeLen
              off += 4; // typeMod
              off += 2; // formatCode
              fields.push({ name, type: typeName(oid) });
            }
            continue;
          }
          if (msg.type === 'D') {
            let off = 0;
            const cnt = msg.body.readInt16BE(off); off += 2;
            const row = {};
            for (let i = 0; i < cnt; i++) {
              const len = msg.body.readInt32BE(off); off += 4;
              if (len === -1) row[fields[i].name] = null;
              else { row[fields[i].name] = msg.body.toString('utf8', off, off + len); off += len; }
            }
            rows.push(row);
            continue;
          }
          if (msg.type === 'C') {
            command = readCStr(msg.body, 0);
            const parts = command.split(' ');
            if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) rowCount = parseInt(parts[parts.length - 1], 10);
            continue;
          }
          if (msg.type === 'Z') break;
        }
        resolve({ fields, rows, rowCount: rowCount || rows.length, command });
      };
      loop().catch(reject);
    });
  }

  end() {
    try {
      if (this.socket && !this.socket.destroyed) {
        this._sendTyped('X', Buffer.alloc(0)); // Terminate
        this.socket.end();
      }
    } catch (_) {}
  }
}

function parseError(body) {
  let off = 0;
  let msg = '';
  let detail = '';
  while (off < body.length) {
    const code = body[off];
    if (code === 0) break;
    const v = readCStr(body, off + 1);
    if (code === 77) msg = v; // M
    else if (code === 68) detail = v; // D
    off = body.indexOf(0, off + 1) + 1;
  }
  return msg + (detail ? ' — ' + detail : '');
}

function parseRowCount(command) {
  // "SELECT 3" / "INSERT 0 5" / "DELETE 2" / "UPDATE 1" / "CREATE TABLE" / "BEGIN"
  const parts = command.split(' ');
  if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) return parseInt(parts[parts.length - 1], 10);
  return 0;
}

module.exports = { PgWire, parseError, parseRowCount, typeName };
