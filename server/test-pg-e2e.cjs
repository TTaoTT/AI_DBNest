/**
 * test-pg-e2e.cjs — 直连本地 PostgreSQL 的端到端验证（零依赖，用自研 pgwire 驱动）
 * 覆盖：SCRAM 连接 / 列库 / 建 schema+表 / 插数 / 查询 / 描述表 / 只读守卫 / 危险检测 / DDL 守卫 / 清理
 *
 * 运行（在 server/ 目录，密码经环境变量传入，不落盘）：
 *   DB_PASSWORD=你的密码 node test-pg-e2e.cjs
 * 可选环境变量：DB_HOST(默认127.0.0.1) DB_PORT(5432) DB_USER(默认postgres) DB_NAME(默认postgres)
 */
const { PgWire } = require('./src/connection/dialects/pgwire.js');
const DBLogic = require('../web/src/lib/db-logic.js');
const fs = require('fs');

// 密码来源优先级：环境变量 DB_PASSWORD > 本地 .pgpwd 文件（不入库）
let password = process.env.DB_PASSWORD || '';
if (!password) {
  try { password = fs.readFileSync('.pgpwd', 'utf8').trim(); } catch (_) {}
}

const CFG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  password,
  database: process.env.DB_NAME || 'postgres',
};

// 用户名候选：优先用显式 DB_USER，否则尝试常见变体（用户手滑把 postgres 打成了 psotgresql）
const USER_CANDIDATES = (process.env.DB_USER ? [process.env.DB_USER] : [])
  .concat(['psotgresql', 'postgres', 'postgresql', 'postgres']);

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

async function main() {
  if (!CFG.password) {
    console.log('⚠ 未提供 DB_PASSWORD。请用：DB_PASSWORD=xxx node test-pg-e2e.cjs');
    process.exit(2);
  }
  section('连接（SCRAM-SHA-256）');
  let wire = null, usedUser = null, lastErr = null;
  for (const u of USER_CANDIDATES) {
    const w = new PgWire({ ...CFG, user: u });
    try { await w.connect(); wire = w; usedUser = u; break; }
    catch (e) { lastErr = e; }
  }
  if (!wire) {
    ok('连接本地 PG 成功', false, lastErr ? lastErr.message : '未知错误');
    process.exit(1);
  }
  ok('连接本地 PG 成功', true);
  console.log('  使用的用户名：' + usedUser + ' @ ' + CFG.host + ':' + CFG.port + '/' + CFG.database);


  section('列库 listDatabases');
  const dbs = await wire.query('SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname');
  const dbNames = dbs.rows.map((r) => r.datname);
  ok('返回数据库列表', Array.isArray(dbNames) && dbNames.length > 0, dbNames.length + ' 个');
  ok('包含 postgres 库', dbNames.includes('postgres'));

  section('建 schema + 建表（DDL）');
  await wire.query('DROP SCHEMA IF EXISTS dbadmin_test CASCADE');
  await wire.query('CREATE SCHEMA dbadmin_test');
  ok('CREATE SCHEMA 成功', true);
  await wire.query(`CREATE TABLE dbadmin_test.users (
      id serial PRIMARY KEY,
      name text NOT NULL,
      email text,
      created_at timestamptz DEFAULT now(),
      balance numeric
  )`);
  ok('CREATE TABLE 成功', true);

  section('插数（write）');
  const ins = await wire.query(
    "INSERT INTO dbadmin_test.users(name,email,balance) VALUES ('Alice','a@x.com',12.5),('Bob','b@x.com',9.0),('Carol','c@x.com',3.3)",
  );
  ok('INSERT 影响 3 行', ins.rowCount === 3, 'rowCount=' + ins.rowCount);

  section('查询（read）+ 列/行校验');
  const q = await wire.query('SELECT id,name,email,balance FROM dbadmin_test.users ORDER BY id');
  ok('查询返回 3 行', q.rowCount === 3, 'rowCount=' + q.rowCount);
  ok('列名正确', JSON.stringify(q.fields.map(c => c.name)) === JSON.stringify(['id', 'name', 'email', 'balance']), q.fields.map(c => c.name).join(','));
  ok('数据正确（首行 Alice）', q.rows[0].name === 'Alice' && q.rows[0].balance === '12.5', JSON.stringify(q.rows[0]));
  ok('类型识别（id=int4, balance=numeric）', q.fields.find((f) => f.name === 'id').type === 'int4' && q.fields.find((f) => f.name === 'balance').type === 'numeric');

  section('描述表 describeTable（元数据）');
  const desc = await wire.query(`SELECT a.attname AS name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS dataType,
      NOT a.attnotnull AS nullable, (i.indisprimary IS NOT NULL) AS pk
    FROM pg_attribute a LEFT JOIN pg_index i ON i.indrelid=a.attrelid AND a.attnum=ANY(i.indkey) AND i.indisprimary
    WHERE a.attrelid=('dbadmin_test'||'.'||'users')::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`);
  const cols = desc.rows.map((c) => ({ name: c.name, dataType: c.datatype, nullable: c.nullable === 't', pk: c.pk === 't' }));
  ok('共 5 列', cols.length === 5, cols.length);
  ok('id 为主键', cols.find((c) => c.name === 'id').pk === true);
  ok('name 非空', cols.find((c) => c.name === 'name').nullable === false);
  ok('email 可空', cols.find((c) => c.name === 'email').nullable === true);
  ok('balance 类型为 numeric', cols.find((c) => c.name === 'balance').dataType === 'numeric');

  section('列表 listTables（对象树）');
  const tbls = await wire.query(
    `SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE c.relkind IN ('r','v') AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY n.nspname,c.relname`,
  );
  const names = tbls.rows.map((r) => r.schema + '.' + r.name);
  ok('对象树含 dbadmin_test.users', names.includes('dbadmin_test.users'), names.filter((n) => n.startsWith('dbadmin_test')).join(','));

  section('只读守卫 + 危险检测 + DDL 守卫（与后端 service 同源逻辑）');
  ok("SELECT 判定为 read", DBLogic.classifySql('SELECT * FROM dbadmin_test.users') === 'read');
  ok("DROP 判定为 ddl", DBLogic.classifySql('DROP TABLE dbadmin_test.users') === 'ddl');
  ok("UPDATE 判定为 write", DBLogic.classifySql('UPDATE dbadmin_test.users SET balance=0') === 'write');
  // 模拟后端 executeQuery 的只读守卫
  const readonlyGuard = (sql, readonly) => readonly && DBLogic.classifySql(sql) !== 'read';
  ok('只读连接拦截 DROP', readonlyGuard('DROP TABLE dbadmin_test.users', true) === true);
  ok('只读连接放行 SELECT', readonlyGuard('SELECT 1', true) === false);
  ok('可写连接放行 DROP', readonlyGuard('DROP TABLE dbadmin_test.users', false) === false);
  const danger = DBLogic.detectDangerous('DELETE FROM dbadmin_test.users');
  ok('无 WHERE 的 DELETE 被标记危险', danger.some((d) => d.type === 'DELETE_NO_WHERE'));
  ok('带 WHERE 的 DELETE 安全', DBLogic.detectDangerous('DELETE FROM dbadmin_test.users WHERE id=1').length === 0);

  section('清理');
  await wire.query('DROP SCHEMA IF EXISTS dbadmin_test CASCADE');
  ok('DROP SCHEMA 清理成功', true);
  wire.end();

  console.log('\n========================================');
  console.log(`结果：通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
  console.log('本地 PostgreSQL 全功能验证通过 ✅');
}

main().catch((e) => {
  console.error('运行异常：', e.message);
  process.exit(1);
});
