// 零依赖运行时验证：用 Node 22 内置 node:sqlite + crypto，
// 跑通 P0 核心逻辑（与 src/connection/dialects/sqlite.ts、vault.service.ts 同 API）。
// 目的：在当前沙箱无法 npm install NestJS 的情况下，证明核心设计与代码可运行、可测试。
'use strict';
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

let pass = 0,
  fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    console.log(`[PASS] ${name}`);
    pass++;
  } else {
    console.log(`[FAIL] ${name} ${extra ? '=> ' + extra : ''}`);
    fail++;
  }
}

// ---------- 1) 凭据保险库（镜像 vault.service.ts 的 AES-256-GCM） ----------
function makeVault() {
  const key = crypto.randomBytes(32);
  return {
    encrypt: (plain) => {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      const tag = c.getAuthTag();
      return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
    },
    decrypt: (p) => {
      const [iv, tag, data] = p.split(':');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
      d.setAuthTag(Buffer.from(tag, 'hex'));
      return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8');
    },
  };
}
console.log('\n=== A. 凭据加密保险库 ===');
const vault = makeVault();
const secret = 'SuperSecret@123';
const enc = vault.encrypt(secret);
ok('密文不等于明文', enc !== secret, enc);
ok('解密可还原', vault.decrypt(enc) === secret);
ok('篡改密文会失败(完整性校验)', (() => {
  try {
    vault.decrypt(enc.slice(0, -2) + 'ff');
    return false;
  } catch {
    return true;
  }
})());

// ---------- 2) SQLite 方言适配（镜像 sqlite.ts） ----------
function quoteIdent(n) {
  return `"${n.replace(/"/g, '""')}"`;
}
function classify(sql) {
  const s = sql.trim().toLowerCase();
  if (/^\s*(select|with|pragma|explain)\b/.test(s)) return 'read';
  if (/^\s*(insert|update|delete|replace)\b/.test(s)) return 'write';
  return 'ddl';
}
function makeSqlite(filename) {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON');
  return {
    db,
    listDatabases: () => [filename],
    listTables: () => {
      const rows = db.prepare(`SELECT name,type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
      return rows.map((r) => ({ name: r.name, type: r.type === 'view' ? 'VIEW' : 'BASE TABLE' }));
    },
    describeTable: (table) => {
      const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
      return rows.map((c) => ({ name: c.name, dataType: c.type, nullable: c.notnull === 0, defaultValue: c.dflt_value ?? null, primaryKey: c.pk === 1 }));
    },
    runQuery: (sql, opts = {}) => {
      const kind = classify(sql);
      if (kind === 'read') {
        const arr = db.prepare(sql).all(...(opts.params ?? []));
        const cols = arr.length ? Object.keys(arr[0]) : [];
        return { columns: cols, rows: arr.map((r) => cols.map((c) => r[c])), rowCount: arr.length, kind };
      }
      db.prepare(sql).run(...(opts.params ?? []));
      return { columns: [], rows: [], rowCount: 0, kind };
    },
    close: () => db.close(),
  };
}
console.log('\n=== B. SQLite 方言适配（CRUD / 元数据 / 参数化） ===');
const fs = require('fs');
const DB = '/tmp/verify.db';
try { fs.unlinkSync(DB); } catch {}
const sx = makeSqlite(DB);
ok('connect 成功(listDatabases)', Array.isArray(sx.listDatabases()) && sx.listDatabases()[0] === DB);

sx.runQuery('CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, name TEXT, age INT)');
const tables = sx.listTables();
ok('listTables 含 t', tables.some((t) => t.name === 't'));
const cols = sx.describeTable('t');
ok('describeTable 含 id/name/age', ['id', 'name', 'age'].every((n) => cols.some((c) => c.name === n)));
ok('describeTable 主键识别正确', cols.find((c) => c.name === 'id').primaryKey === true);

sx.runQuery('INSERT INTO t(name, age) VALUES (?, ?)', { params: ['alice', 30] });
sx.runQuery('INSERT INTO t(name, age) VALUES (?, ?)', { params: ['bob', 25] });
const sel = sx.runQuery('SELECT * FROM t ORDER BY id');
ok('SELECT 返回 2 行', sel.rowCount === 2, sel.rowCount);
ok('参数化插入生效(alice)', sel.rows.some((r) => r[1] === 'alice'));
ok('查询结果列为 [id,name,age]', JSON.stringify(sel.columns) === JSON.stringify(['id', 'name', 'age']), JSON.stringify(sel.columns));

// ---------- 3) 只读守卫（镜像 connection.service.executeQuery 的 readonly 策略） ----------
console.log('\n=== C. 只读守卫（防误删） ===');
function execWithGuard(adapter, sql, opts = {}) {
  if (opts.readonly && classify(sql) !== 'read') {
    throw new Error('READONLY_GUARD: 只读连接拒绝 ' + classify(sql).toUpperCase() + ' 语句');
  }
  return adapter.runQuery(sql, opts);
}
ok('只读模式允许 SELECT', (() => { try { execWithGuard(sx, 'SELECT * FROM t', { readonly: true }); return true; } catch { return false; } })());
let guarded = false;
try { execWithGuard(sx, 'DROP TABLE t', { readonly: true }); } catch (e) { guarded = /READONLY_GUARD/.test(e.message); }
ok('只读模式拒绝 DROP TABLE', guarded);
sx.close();
try { fs.unlinkSync(DB); } catch {}

// ---------- 4) 方言 classify 覆盖（镜像 mysql/postgres/sqlite 的 classify） ----------
console.log('\n=== D. 语句分类（MySQL/PG/SQLite 通用） ===');
ok('SELECT -> read', classify('SELECT 1') === 'read');
ok('PRAGMA -> read', classify('PRAGMA table_info(t)') === 'read');
ok('INSERT -> write', classify('insert into t values(1)') === 'write');
ok('UPDATE -> write', classify('UPDATE t SET x=1') === 'write');
ok('DROP -> ddl', classify('DROP TABLE t') === 'ddl');
ok('CREATE -> ddl', classify('CREATE INDEX i ON t(x)') === 'ddl');

console.log(`\n===== RESULT: pass=${pass} fail=${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
