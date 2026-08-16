/**
 * ui-interaction.test.cjs — 前端交互级测试（驱动真实本地 PostgreSQL）
 *
 * 通过前端交互逻辑模块（ui-interactions.js / db-logic.js）模拟用户在界面上的操作，
 * 并经由真实 PgWire 驱动落到本地 PG，验证"功能设计"在交互层被满足：
 *   1) 连接 → 2) 由真实元数据构建对象树 → 3) 双击单元格编辑→生成参数化UPDATE→提交→查库核实
 *   4) 只读连接禁止编辑 + 拦截 DDL → 5) 危险操作需二次确认 → 6) 虚拟滚动窗口计算
 *
 * 运行（密码经环境变量，不落盘）：  DB_PASSWORD=123456 node web/test/ui-interaction.test.cjs
 */
const path = require('path');
const { PgWire } = require(path.join(__dirname, '../../server/src/connection/dialects/pgwire.js'));
const UI = require(path.join(__dirname, '../src/lib/ui-interactions.js'));
const DBLogic = require(path.join(__dirname, '../src/lib/db-logic.js'));
const fs = require('fs');

let password = process.env.DB_PASSWORD || '';
if (!password) { try { password = fs.readFileSync(path.join(__dirname, '../../server/.pgpwd'), 'utf8').trim(); } catch (_) {} }

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

async function main() {
  if (!password) { console.log('⚠ 未提供 DB_PASSWORD。请用：DB_PASSWORD=xxx node web/test/ui-interaction.test.cjs'); process.exit(2); }
  const wire = new PgWire({ user: 'postgres', password, database: 'postgres' });
  section('连接（真实 PG）');
  await wire.connect();
  ok('前端连接真实 PG 成功', true);

  const SCHEMA = 'dbadmin_ui';
  section('建测试表（DDL，供交互测试）');
  await wire.query('DROP SCHEMA IF EXISTS ' + SCHEMA + ' CASCADE');
  await wire.query('CREATE SCHEMA ' + SCHEMA);
  await wire.query('CREATE TABLE ' + SCHEMA + '.users (id serial PRIMARY KEY, name text NOT NULL, email text, balance numeric)');
  await wire.query("INSERT INTO " + SCHEMA + ".users(name,email,balance) VALUES ('Alice','a@x.com',12.5),('Bob','b@x.com',9.0)");
  ok('测试表就绪', true);

  section('对象树：由真实元数据构建（前端交互：左侧树）');
  const dbs = await wire.query("SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname");
  const tbls = await wire.query(
    "SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY n.nspname,c.relname",
  );
  const meta = {
    databases: dbs.rows.map((d) => ({
      name: d.datname,
      schemas: (d.datname === 'postgres'
        ? tbls.rows.filter((t) => t.schema === SCHEMA).map((t) => ({ name: t.schema, tables: [{ name: t.name, columns: [] }] }))
        : []),
    })),
  };
  const tree = UI.buildObjectTree(meta);
  const testTableNode = tree.find((db) => db.name === 'postgres')
    && tree.find((db) => db.name === 'postgres').children
      .find((sc) => sc.name === SCHEMA)
      && tree.find((db) => db.name === 'postgres').children.find((sc) => sc.name === SCHEMA).children
        .find((t) => t.name === 'users');
  ok('对象树含 postgres.' + SCHEMA + '.users', !!testTableNode, JSON.stringify(tree.map(d => d.name)));

  // 拉真实列元数据填入对象树
  const desc = await wire.query(
    `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS dataType, NOT a.attnotnull AS nullable, (i.indisprimary IS NOT NULL) AS pk
     FROM pg_attribute a LEFT JOIN pg_index i ON i.indrelid=a.attrelid AND a.attnum=ANY(i.indkey) AND i.indisprimary
     WHERE a.attrelid=('${SCHEMA}'||'.'||'users')::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
  );
  const cols = desc.rows.map((c) => ({ name: c.name, type: c.datatype, pk: c.pk === 't', nullable: c.nullable === 't' }));
  ok('对象树列元数据正确（id 主键, balance numeric）', cols.find(c => c.name === 'id').pk && cols.find(c => c.name === 'balance').type === 'numeric');

  section('数据网格：打开表取真实行（前端交互：虚拟网格数据）');
  const grid = await wire.query('SELECT id,name,email,balance FROM ' + SCHEMA + '.users ORDER BY id');
  ok('网格返回 2 行', grid.rowCount === 2, 'rowCount=' + grid.rowCount);

  section('单元格内联编辑 → 生成参数化 UPDATE → 提交 → 查库核实（前端核心交互）');
  const conn = { readonly: false };
  const edit = { table: SCHEMA + '.users', pk: 'id', pkValue: 1, column: 'balance', value: 99.9 };
  const guard = UI.canEditCell(conn, cols.find(c => c.name === 'balance'));
  ok('可写连接允许编辑单元格', guard.ok === true);
  const upd = UI.generateUpdate(edit.table, edit.pk, edit.pkValue, edit.column, edit.value);
  ok('生成参数化 UPDATE', upd.sql === 'UPDATE ' + SCHEMA + '.users SET balance = $1 WHERE id = $2' && upd.params[0] === 99.9 && upd.params[1] === 1, upd.sql);
  // 真实提交（扩展协议，参数化，防注入）
  await wire.queryParams(upd.sql, upd.params);
  const after = await wire.query('SELECT balance FROM ' + SCHEMA + '.users WHERE id=1');
  ok('编辑已落到真实库（balance=99.9）', after.rows[0].balance === '99.9', 'balance=' + after.rows[0].balance);

  section('只读守卫：只读连接禁止编辑 + 拦截 DDL（前端交互：只读开关）');
  const roConn = { readonly: true };
  const roGuard = UI.canEditCell(roConn, cols.find(c => c.name === 'balance'));
  ok('只读连接禁止编辑', roGuard.ok === false);
  const roEval = UI.evaluateQuery(roConn, 'DROP TABLE ' + SCHEMA + '.users');
  ok('只读连接拦截 DROP', roEval.action === 'block', roEval.action);
  const roSelect = UI.evaluateQuery(roConn, 'SELECT * FROM ' + SCHEMA + '.users');
  ok('只读连接放行 SELECT', roSelect.action === 'run');

  section('危险操作二次确认（前端交互：危险确认弹窗）');
  const dangerEval = UI.evaluateQuery({ readonly: false }, 'DELETE FROM ' + SCHEMA + '.users');
  ok('无 WHERE 的 DELETE 触发确认', dangerEval.action === 'confirm' && dangerEval.danger.some(d => d.type === 'DELETE_NO_WHERE'));
  const safeEval = UI.evaluateQuery({ readonly: false }, 'DELETE FROM ' + SCHEMA + '.users WHERE id=1');
  ok('带 WHERE 的 DELETE 直接放行', safeEval.action === 'run');

  section('虚拟滚动窗口计算（前端交互：10万行虚拟表格）');
  const win = DBLogic.computeVirtualRange(0, 28, 400, 100000, 6);
  ok('窗口起始=0 且只渲染少量行', win.startIndex === 0 && win.endIndex <= win.startIndex + 30, JSON.stringify(win).slice(0, 80));
  const win2 = DBLogic.computeVirtualRange(500000, 28, 400, 100000, 6); // 滚到第 500000px
  ok('滚动后窗口跟随（startIndex>0）', win2.startIndex > 0);

  section('数据网格：筛选 / 排序 / 分页（前端交互：列筛选+排序+限制加载更多）');
  await wire.query("INSERT INTO " + SCHEMA + ".users(name,email,balance) VALUES ('Carol','c@x.com',50.0),('Dave','d@x.com',3.2),('Eve','e@x.com',77.7)");
  // 筛选 balance>10 + 降序（Alice 在前序测试中已被改为 99.9）
  const filt = UI.buildSelect(SCHEMA + '.users', { where: [{ column: 'balance', op: '>', value: 10 }], orderBy: { column: 'balance', dir: 'DESC' } });
  const fq = await wire.queryParams(filt.sql, filt.params);
  ok('筛选+降序：balance>10 返 3 行且首行 Alice(99.9)', fq.rowCount === 3 && fq.rows[0].name === 'Alice', 'rowCount=' + fq.rowCount + ' first=' + (fq.rows[0] && fq.rows[0].name));
  // 分页 LIMIT 2
  const page = UI.buildSelect(SCHEMA + '.users', { orderBy: { column: 'id', dir: 'ASC' }, limit: 2, offset: 0 });
  const pq = await wire.queryParams(page.sql, page.params);
  ok('分页：LIMIT 2 返回 2 行', pq.rowCount === 2, 'rowCount=' + pq.rowCount);

  section('本地筛选 / 排序（前端内存数据集即时交互，无需回服务端）');
  const sample = [
    { id: 1, name: 'Alice', balance: 12.5 },
    { id: 2, name: 'Bob', balance: 9.0 },
    { id: 3, name: 'Carol', balance: 50.0 },
  ];
  const fLocal = UI.applyFilter(sample, [{ column: 'balance', op: '>', value: 10 }]);
  ok('本地筛选 balance>10 → 2 行', fLocal.length === 2, 'len=' + fLocal.length);
  const sLocal = UI.applySort(sample, 'balance', 'DESC');
  ok('本地排序 DESC → 首行 Carol', sLocal[0].name === 'Carol', sLocal[0] && sLocal[0].name);

  section('新增行 / 删除行（前端交互：工具栏按钮 → 参数化 DML → 落库核实）');
  const ins = UI.generateInsert(SCHEMA + '.users', { name: 'Frank', email: 'f@x.com', balance: 5.5 });
  await wire.queryParams(ins.sql, ins.params);
  const afterIns = await wire.queryParams('SELECT count(*) AS c FROM ' + SCHEMA + '.users WHERE name=$1', ['Frank']);
  ok('新增行已落库', afterIns.rows[0].c === '1', 'c=' + afterIns.rows[0].c);
  const del = UI.generateDelete(SCHEMA + '.users', 'name', 'Frank');
  await wire.queryParams(del.sql, del.params);
  const afterDel = await wire.queryParams('SELECT count(*) AS c FROM ' + SCHEMA + '.users WHERE name=$1', ['Frank']);
  ok('删除行已从库移除', afterDel.rows[0].c === '0', 'c=' + afterDel.rows[0].c);

  section('清理');
  await wire.query('DROP SCHEMA IF EXISTS ' + SCHEMA + ' CASCADE');
  wire.end();
  ok('测试 schema 已清理', true);

  console.log('\n========================================');
  console.log(`前端交互级测试：通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
  console.log('前端交互层驱动真实 PostgreSQL 全部验证通过 ✅');
}

main().catch((e) => { console.error('运行异常：', e.message); process.exit(1); });
