/**
 * db-logic.test.cjs — 零依赖前端核心逻辑测试（Node 现跑）
 * 运行：node web/test/db-logic.test.cjs
 */
const L = require('../src/lib/db-logic.js');

let pass = 0;
let fail = 0;
const fails = [];

function ok(name, cond) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    fails.push(name);
    console.log('  ✗ ' + name);
  }
}

console.log('== A) SQL 分类 ==');
ok("SELECT -> read", L.classifySql('SELECT * FROM users') === 'read');
ok("SELECT 带注释 -> read", L.classifySql('-- 注释\nSELECT 1') === 'read');
ok("WITH CTE -> read", L.classifySql('WITH t AS (SELECT 1) SELECT * FROM t') === 'read');
ok("SHOW TABLES -> read", L.classifySql('SHOW TABLES') === 'read');
ok("PRAGMA -> read", L.classifySql('PRAGMA table_info(users)') === 'read');
ok("EXPLAIN -> read", L.classifySql('EXPLAIN SELECT * FROM t') === 'read');
ok("INSERT -> write", L.classifySql('insert into t(a) values(1)') === 'write');
ok("UPDATE -> write", L.classifySql('UPDATE t SET a=1 WHERE id=2') === 'write');
ok("DELETE -> write", L.classifySql('DELETE FROM t WHERE id=3') === 'write');
ok("DROP -> ddl", L.classifySql('DROP TABLE t') === 'ddl');
ok("CREATE -> ddl", L.classifySql('CREATE TABLE t(id int)') === 'ddl');
ok("ALTER -> ddl", L.classifySql('ALTER TABLE t ADD col int') === 'ddl');
ok("空串 -> other", L.classifySql('   ') === 'other');
ok("/* 块注释 */ SELECT -> read", L.classifySql('/* c */ SELECT 1') === 'read');

console.log('== B) 只读守卫 ==');
ok("只读连接放行 SELECT", L.isReadOnlyStatement('SELECT 1') === true);
ok("只读连接拦截 DROP", L.isReadOnlyStatement('DROP TABLE t') === false);
ok("只读连接拦截 UPDATE", L.isReadOnlyStatement('UPDATE t SET a=1') === false);

console.log('== C) 危险语句检测 ==');
ok("DROP 被标记", L.detectDangerous('DROP TABLE t').some(d => d.type === 'DROP'));
ok("TRUNCATE 被标记", L.detectDangerous('TRUNCATE TABLE t').some(d => d.type === 'TRUNCATE'));
ok("无 WHERE 的 DELETE 被标记", L.detectDangerous('DELETE FROM t').some(d => d.type === 'DELETE_NO_WHERE'));
ok("无 WHERE 的 UPDATE 被标记", L.detectDangerous('UPDATE t SET a=1').some(d => d.type === 'UPDATE_NO_WHERE'));
ok("带 WHERE 的 DELETE 安全", L.detectDangerous('DELETE FROM t WHERE id=1').length === 0);
ok("普通 SELECT 无危险", L.detectDangerous('SELECT * FROM t').length === 0);

console.log('== D) 连接校验 ==');
ok("MySQL 合法配置通过", L.validateConnection({ type: 'mysql', host: '127.0.0.1', port: 3306, username: 'root' }).valid === true);
ok("缺主机报错", L.validateConnection({ type: 'mysql' }).errors.length > 0);
ok("非法端口报错", L.validateConnection({ type: 'mysql', host: 'h', port: 70000 }).errors.length > 0);
ok("SQLite 缺文件路径报错", L.validateConnection({ type: 'sqlite' }).errors.length > 0);
ok("SQLite 有路径通过", L.validateConnection({ type: 'sqlite', filePath: '/tmp/a.db' }).valid === true);
ok("未知类型报错", L.validateConnection({ type: 'cobol' }).valid === false);
ok("缺用户名给 warning 不致命", (() => { const r = L.validateConnection({ type: 'postgresql', host: 'h', port: 5432 }); return r.valid && r.warnings.length > 0; })());

console.log('== E) 虚拟窗口计算 ==');
{
  const r = L.computeVirtualRange(0, 28, 280, 100000, 6);
  ok("首屏 startIndex=0", r.startIndex === 0);
  ok("首屏可见行≈10", r.visibleCount === 10);
  ok("总高=行数*行高", r.totalHeight === 2800000);
  const r2 = L.computeVirtualRange(28 * 5000, 28, 280, 100000, 6);
  ok("滚动后 startIndex 合理", r2.startIndex > 4900 && r2.startIndex < 5100);
  ok("endIndex <= 总行数", r2.endIndex <= 100000);
  const r3 = L.computeVirtualRange(99999999, 28, 280, 100000, 6);
  ok("超出底部被钳制", r3.startIndex + r3.visibleCount <= 100000);
  const r4 = L.computeVirtualRange(0, 28, 280, 0, 6);
  ok("空表安全", r4.totalHeight === 0 && r4.endIndex === 0);
}

console.log('== F) 单元格格式化 ==');
ok("NULL -> isNull", L.formatCell(null).isNull === true && L.formatCell(null).text === 'NULL');
ok("数字 -> 字符串", L.formatCell(42).text === '42' && L.formatCell(42).isNull === false);
ok("对象 -> JSON", L.formatCell({ a: 1 }).text === '{"a":1}');
ok("日期 -> ISO", L.formatCell(new Date('2026-01-01T00:00:00Z')).text === '2026-01-01T00:00:00.000Z');

console.log('\n========================================');
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log('失败项：\n - ' + fails.join('\n - '));
  process.exit(1);
} else {
  console.log('全部通过 ✅');
}
