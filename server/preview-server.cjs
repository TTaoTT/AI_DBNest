/**
 * preview-server.cjs — 零依赖（仅 Node 内置 http/net/crypto）预览服务器
 *
 * 作用：把 web/preview/index.html 真正跑起来，并让它直连本地 PostgreSQL（经 pgwire.js）。
 * 既提供静态文件，也提供 JSON API，使预览页从「模拟数据」升级为「真实库交互」。
 *
 * 端点：
 *   GET  /                              → web/preview/index.html
 *   GET  /preview/...                   → web/preview/...
 *   GET  /src/lib/...                   → web/src/lib/...
 *   POST /api/ping                      → { ok:true }
 *   POST /api/connect   {host,port,username,password,database}
 *                                    → { connId, user, database }（自动尝试候选用户名，兼容 psotgresql→postgres 笔误）
 *   POST /api/metadata  {connId}        → { databases:[{name, schemas:[{name, tables:[{name,columns:[{name,type,pk,nullable}]}], views:[{name}]}]}] }
 *   POST /api/query     {connId, sql, params?}   → { fields, rows, rowCount, command }
 *   POST /api/execute   {connId, sql, params}     → 参数化写入（UPDATE/INSERT/DELETE）
 *   POST /api/disconnect{connId}
 *
 * 运行： node server/preview-server.cjs   （默认端口 5180，可用 PREVIEW_PORT 覆盖）
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PgWire } = require('./src/connection/dialects/pgwire.js');
const { SqliteDriver } = require('./src/connection/dialects/sqlite-driver.cjs');
const UI = require('../web/src/lib/ui-interactions.js');
// 补丁更新核心工具（overlay 解析 / manifest / 增量应用）
const UpdateUtils = require('./src/update/update-utils.cjs');

// MySQL 协议族驱动（mysql/mariadb/tidb/oceanbase 共用）。
// mysql2 非内置，联网 `npm install mysql2` 后自动启用；未安装时 doConnect 给出明确提示。
// MySQL 驱动解析：overlay 不携带 node_modules，统一从安装基准 app 目录解析（mysql2 由安装包自带）
const __reqMysql = (function () {
  try { return require('module').createRequire(path.join(UpdateUtils.getBaseAppDir(), '_noop.js')); }
  catch (_) { return function () { throw new Error('createRequire 不可用'); }; }
})();

class MySqlDriver {
  constructor(mysql2, opts) { this._m = mysql2; this.opts = opts; this.type = 'mysql'; this.database = opts.database || ''; }
  // 兼容统一关闭接口（其他驱动用 end()）
  async end() { await this.disconnect(); }
  async connect() {
    this.pool = this._m.createPool({
      host: this.opts.host, port: this.opts.port, user: this.opts.user,
      password: this.opts.password, database: this.opts.database,
      connectionLimit: 5, waitForConnections: true, connectTimeout: 10000,
      supportBigNumbers: true, bigNumberStrings: true,
    });
    const conn = await this.pool.getConnection();
    let [[r]] = await conn.query('SELECT DATABASE() AS db, CURRENT_USER() AS u');
    // 连接时未指定库（database 为空）：自动选第一个非系统库作为默认库，避免裸表名 SQL 报 No database selected
    if (!r || !r.db) {
      const [dbs] = await conn.query("SHOW DATABASES");
      const all = (dbs || []).map((x) => Object.values(x)[0]).filter((d) => d && !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(d));
      if (all.length) {
        await conn.query('USE `' + String(all[0]).replace(/`/g, '``') + '`');
        const [[r2]] = await conn.query('SELECT DATABASE() AS db');
        r = r2 || r;
      }
    }
    conn.release();
    this.user = (r && r.u) || this.opts.user || '';
    this.database = (r && r.db) || this.database;
  }
  async disconnect() { try { await this.pool.end(); } catch (_) {} }
  // 把 PG 风格 $N 占位符转为 mysql2 的 ?（前端 buildSelect 统一生成 PG 方言）
  queryParams(sql, params) {
    params = params || [];
    let i = 0;
    const converted = sql.replace(/\$(\d+)/g, () => { i++; return '?'; });
    return this.query(converted, params);
  }
  async query(sql, params) {
    params = params || [];
    // 统一把双引号标识符转为反引号（无论参数化与否都必经这里，修复无 WHERE 查询 MySQL 报错）
    const converted = sql.replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '`$1`');
    const [rows, fields] = await this.pool.query(converted, params);
    return { rows: Array.isArray(rows) ? rows : [], fields: (fields || []).map((f) => ({ name: f.name, type: String(f.type || '') })), command: 'OK' };
  }
}

const PORT = Number(process.env.PREVIEW_PORT) || 5180;
const WEBROOT = path.resolve(__dirname, '..', 'web');
const CONNS = new Map();
// 构建号：由 index.html 内容哈希生成——文件一变构建号必变，浏览器可据此判断版本
const BUILD_ID = (() => {
  try {
    const c = require('crypto').createHash('md5');
    c.update(fs.readFileSync(path.join(WEBROOT, 'preview', 'index.html'), 'utf8'));
    return c.digest('hex').slice(0, 10);
  } catch (_) { return 'dev-' + Date.now(); }
})();
// 审计日志（内存，环形 500 条）：连接/查询/执行/结构变更全量留痕
const AUDIT = [];
const AUDIT_MAX = 500;
function audit(kind, connId, detail) {
  AUDIT.push({ ts: new Date().toISOString(), kind, connId: connId || '-', detail: String(detail || '').slice(0, 400) });
  if (AUDIT.length > AUDIT_MAX) AUDIT.splice(0, AUDIT.length - AUDIT_MAX);
}

const TYPE_SHORT = {
  integer: 'int4', bigint: 'int8', smallint: 'int2',
  'character varying': 'varchar', character: 'bpchar',
  numeric: 'numeric', 'timestamp without time zone': 'timestamp',
  'timestamp with time zone': 'timestamptz', 'time without time zone': 'time',
  'time with time zone': 'timetz', date: 'date', boolean: 'bool',
  text: 'text', json: 'json', jsonb: 'jsonb', ARRAY: 'array',
  uuid: 'uuid', bytea: 'bytea', 'double precision': 'float8', real: 'float4',
  USER_DEFINED: 'udt',
};
function typeShort(t) { return TYPE_SHORT[t] || t; }

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 每个连接串行化查询：pgwire 单 socket 队列，并发会错乱消息
function withLock(conn, fn) {
  const run = (conn._lock || Promise.resolve()).then(fn, fn);
  conn._lock = run.catch(() => {});
  return run;
}

async function doConnect(cfg) {
  const rawType = String(cfg.type || 'postgresql').toLowerCase();
  // 协议族归一：前端用 postgresql/openGauss/kingbase 走 pg；mysql/mariadb/tidb/oceanbase 走 mysql；sqlite 独立
  const PG_TYPES = ['postgresql', 'postgres', 'opengauss', 'kingbase', 'gaussdb'];
  const MYSQL_TYPES = ['mysql', 'mariadb', 'tidb', 'oceanbase'];
  const family = MYSQL_TYPES.includes(rawType) ? 'mysql' : (PG_TYPES.includes(rawType) ? 'pg' : rawType);
  if (family === 'sqlite') {
    const c = new SqliteDriver({ file: cfg.database || cfg.file || 'local.db' });
    try {
      const info = await c.connect();
      const connId = 'c' + Math.random().toString(36).slice(2, 10);
      c._lock = Promise.resolve();
      CONNS.set(connId, c);
      audit('connect', connId, 'sqlite ' + cfg.database);
      return { connId, user: info.user, database: info.database, type: rawType };
    } catch (e) { throw e; }
  }
  if (family === 'mysql') {
    // MySQL 协议族：有 mysql2 则用（安装包自带，统一从基准 node_modules 解析）；否则给出明确提示
    let mysql2;
    try { mysql2 = __reqMysql('mysql2/promise'); }
    catch (_) { throw new Error('MySQL 协议族（MySQL/MariaDB/TiDB/OceanBase）需要 mysql2 驱动。请先执行: cd server && npm install mysql2'); }
    const c = new MySqlDriver(mysql2, {
      host: cfg.host || '127.0.0.1',
      port: Number(cfg.port) || 3306,
      user: cfg.username || 'root',
      password: cfg.password || '',
      database: cfg.database,
    });
    await c.connect();
    c._mysql = true;
    const connId = 'c' + Math.random().toString(36).slice(2, 10);
    c._lock = Promise.resolve();
    CONNS.set(connId, c);
    audit('connect', connId, 'mysql ' + cfg.host + ':' + cfg.port + '/' + (c.database || cfg.database));
    return { connId, user: cfg.username || 'root', database: c.database || cfg.database || '', type: rawType };
  }
  if (family === 'oracle' || family === 'mssql' || family === 'mongo') {
    throw new Error('数据库类型 ' + rawType + ' 的适配器将在 P0-2 阶段实现（需安装对应驱动）');
  }
  const given = (cfg.username || '').trim();
  const candidates = [given, 'postgres', 'postgresql', 'psotgresql']
    .filter((v, i, a) => v && a.indexOf(v) === i);
  let lastErr;
  for (const u of candidates) {
    const c = new PgWire({
      host: cfg.host || '127.0.0.1',
      port: Number(cfg.port) || 5432,
      user: u,
      password: cfg.password || '',
      database: cfg.database || u,
    });
    try {
      await c.connect();
      // 会话级查询超时：慢查询由 PG 优雅取消（报错但不销毁连接），避免 socket 级超时误杀
      try { await c.query('SET statement_timeout = ' + (Number(process.env.PG_STMT_TIMEOUT) || 60000)); } catch (_) {}
      const connId = 'c' + Math.random().toString(36).slice(2, 10);
      c._lock = Promise.resolve();
      // 保存连接凭据，供按库浏览（/api/metadata?db=xxx 与 /api/connect-db）临时建连用
      c._cfg = { host: cfg.host || '127.0.0.1', port: Number(cfg.port) || 5432, user: u, password: cfg.password || '' };
      CONNS.set(connId, c);
      audit('connect', connId, 'pg ' + c.database);
      return { connId, user: u, database: c.database, type: rawType };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('连接失败');
}

// 按库建立独立连接：用原连接凭据连到指定数据库，返回新 connId（PG 族：一个连接绑定一个库，
// 打开其他库的表必须用该库自己的连接，否则 "库"."表" 会被当成 schema 报错）
async function doConnectDb(baseConn, db) {
  if (!baseConn._cfg) throw new Error('该连接不支持按库切换');
  const isPg = !baseConn._mysql && baseConn.type !== 'sqlite';
  if (isPg) {
    const c = new PgWire({ host: baseConn._cfg.host, port: baseConn._cfg.port, user: baseConn._cfg.user, password: baseConn._cfg.password || '', database: db });
    await c.connect();
    try { await c.query('SET statement_timeout = ' + (Number(process.env.PG_STMT_TIMEOUT) || 60000)); } catch (_) {}
    const connId = 'c' + Math.random().toString(36).slice(2, 10);
    c._lock = Promise.resolve();
    c._cfg = baseConn._cfg;
    CONNS.set(connId, c);
    audit('connect-db', connId, 'pg ' + db);
    return { connId, user: baseConn._cfg.user, database: db, type: 'postgresql' };
  }
  if (baseConn._mysql) {
    let mysql2;
    try { mysql2 = require('mysql2/promise'); } catch (_) { throw new Error('MySQL 驱动未安装'); }
    const c = new MySqlDriver(mysql2, { host: baseConn._cfg.host, port: baseConn._cfg.port, user: baseConn._cfg.user, password: baseConn._cfg.password || '', database: db });
    await c.connect();
    c._mysql = true;
    const connId = 'c' + Math.random().toString(36).slice(2, 10);
    c._lock = Promise.resolve();
    CONNS.set(connId, c);
    audit('connect-db', connId, 'mysql ' + db);
    return { connId, user: baseConn._cfg.user, database: db, type: 'mysql' };
  }
  throw new Error('该数据库类型不支持按库连接');
}
// 返回连接对象（而非 connId），供传输/同步内部使用；不注册到 CONNS
async function connectDbInternal(baseConn, db) {
  if (!baseConn._cfg) throw new Error('该连接不支持按库切换');
  const isPg = !baseConn._mysql && baseConn.type !== 'sqlite';
  if (isPg) {
    const c = new PgWire({ host: baseConn._cfg.host, port: baseConn._cfg.port, user: baseConn._cfg.user, password: baseConn._cfg.password || '', database: db });
    await c.connect();
    try { await c.query('SET statement_timeout = ' + (Number(process.env.PG_STMT_TIMEOUT) || 60000)); } catch (_) {}
    c._lock = Promise.resolve();
    c._cfg = baseConn._cfg;
    c._mysql = false; c.type = 'postgresql';
    return c;
  }
  if (baseConn._mysql) {
    let mysql2;
    try { mysql2 = require('mysql2/promise'); } catch (_) { throw new Error('MySQL 驱动未安装'); }
    const c = new MySqlDriver(mysql2, { host: baseConn._cfg.host, port: baseConn._cfg.port, user: baseConn._cfg.user, password: baseConn._cfg.password || '', database: db });
    await c.connect();
    c._mysql = true; c.type = 'mysql';
    c._lock = Promise.resolve();
    c._cfg = baseConn._cfg;
    return c;
  }
  throw new Error('该数据库类型不支持按库连接');
}

async function doMetadata(conn, db) {
  if (conn.type === 'sqlite') {
    return withLock(conn, async () => {
      const objs = (await conn.query("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows || [];
      const tables = [], views = [];
      for (const o of objs) {
        const cols = (await conn.query('PRAGMA table_info(' + JSON.stringify(o.name) + ')')).rows.map((c) => ({
          name: c.name, type: c.type || 'text', pk: c.pk > 0, nullable: c.notnull !== 1,
        }));
        (o.type === 'view' ? views : tables).push({ name: o.name, columns: cols });
      }
      return { databases: [{ name: conn.database, schemas: [{ name: 'main', tables, views }] }] };
    });
  }
  // MySQL 协议族（mysql/mariadb/tidb/oceanbase）：information_schema 元数据
  if (conn._mysql) {
    return withLock(conn, async () => {
      const cur = conn.database || conn.opts.database;
      const dbList = await conn.query("SHOW DATABASES");
      const allDbs = (dbList.rows || []).map((r) => Object.values(r)[0]).filter((d) => d && !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(d));
      const dbs = allDbs.length ? allDbs : [cur || 'mysql'];
      const out = [];
      for (const name of dbs) {
        const tbl = await conn.query(
          `SELECT table_name AS tname, table_type AS ttype FROM information_schema.tables
           WHERE table_schema = ? AND table_type IN ('BASE TABLE','VIEW') ORDER BY table_name`, [name]);
        const col = await conn.query(
          `SELECT table_name AS tname, column_name AS cname, data_type AS dtype, is_nullable AS inull, column_key AS ckey
           FROM information_schema.columns WHERE table_schema = ? ORDER BY ordinal_position`, [name]);
        const tables = [], views = [];
        const colByTbl = {};
        (col.rows || []).forEach((c) => { (colByTbl[c.tname] = colByTbl[c.tname] || []).push({ name: c.cname, type: c.dtype, pk: c.ckey === 'PRI', nullable: c.inull === 'YES' }); });
        (tbl.rows || []).forEach((r) => {
          const node = { name: r.tname, columns: colByTbl[r.tname] || [] };
          (String(r.ttype) === 'VIEW' ? views : tables).push(node);
        });
        out.push({ name, schemas: [{ name: name, tables, views }] });
      }
      return { databases: out };
    });
  }
  // PG / openGauss / KingbaseES：列出实例所有库，支持按库浏览
  return withLock(conn, () => _pgMetadataCore(conn, conn.database, db));
}

// PG 元数据核心：枚举某实例所有数据库，加载当前库 schemas；其余库只列名字（前端懒加载再连）
async function _pgMetadataCore(conn, activeDb, targetDb) {
  const dbs = (await conn.query(
    "SELECT datname FROM pg_database WHERE datistemplate = false AND datname NOT LIKE 'template%' ORDER BY datname"
  )).rows.map((r) => r.datname);
  if (!dbs.length) dbs.push(activeDb || 'postgres');
  const out = [];
  for (const name of dbs) {
    if (targetDb && name !== targetDb) continue;      // 只看目标库
    if (name !== activeDb && name !== targetDb) {      // 非当前库：仅名字，前端点开再连
      out.push({ name, schemas: [] });
      continue;
    }
    let c = conn;
    let tmp = null;
    if (targetDb && targetDb !== activeDb) {           // 目标库≠当前连接库：临时建连
      if (!conn._cfg || !conn.user) { out.push({ name, schemas: [] }); continue; }
      tmp = new PgWire({ host: conn._cfg.host, port: conn._cfg.port, user: conn.user, password: conn._cfg.password || '', database: name });
      try { await tmp.connect(); c = tmp; } catch (_) { out.push({ name, schemas: [] }); continue; }
    }
    const tbl = await c.query(
      `SELECT table_schema, table_name, table_type FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog','information_schema','pg_toast') ORDER BY table_schema, table_name`
    );
    const col = await c.query(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog','information_schema','pg_toast') ORDER BY table_schema, table_name, ordinal_position`
    );
    const pk = await c.query(
      `SELECT tc.table_schema, tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema AND tc.table_name = kcu.table_name
       WHERE tc.constraint_type = 'PRIMARY KEY'`
    );
    // 函数 / 序列（PG 族）：供对象树「函数 / 序列」分组
    const funcs = await c.query(
      `SELECT n.nspname AS schema, p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prokind IN ('f','p')
       ORDER BY n.nspname, p.proname`
    );
    const seqs = await c.query(
      `SELECT schemaname AS schema, sequencename AS name FROM pg_sequences
       WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname, sequencename`
    );
    if (tmp) { try { tmp.end(); } catch (_) {} }
    const pkMap = {};
    pk.rows.forEach((r) => {
      const k = r.table_schema + '.' + r.table_name;
      (pkMap[k] = pkMap[k] || new Set()).add(r.column_name);
    });
    const schemas = {};          // schemaName -> { name, tables:[], views:[] }
    const tableNodes = {};       // "schema.table" -> 节点（含 columns:[]）
    tbl.rows.forEach((r) => {
      const sk = r.table_schema;
      const sc = schemas[sk] || (schemas[sk] = { name: sk, tables: [], views: [] });
      const key = sk + '.' + r.table_name;
      const node = { name: r.table_name, columns: [] };
      tableNodes[key] = node;
      if (r.table_type === 'VIEW') sc.views.push(node);
      else sc.tables.push(node);
    });
    col.rows.forEach((c) => {
      const key = c.table_schema + '.' + c.table_name;
      const node = tableNodes[key];
      if (!node) return;
      node.columns.push({
        name: c.column_name, type: typeShort(c.data_type),
        pk: !!(pkMap[key] && pkMap[key].has(c.column_name)),
        nullable: c.is_nullable === 'YES',
      });
    });
    // 函数/序列并入对应 schema 节点
    (funcs.rows || []).forEach((f) => {
      const sc = schemas[f.schema] || (schemas[f.schema] = { name: f.schema, tables: [], views: [] });
      (sc.functions = sc.functions || []).push({ name: f.name, args: f.args || '' });
    });
    (seqs.rows || []).forEach((s) => {
      const sc = schemas[s.schema] || (schemas[s.schema] = { name: s.schema, tables: [], views: [] });
      (sc.sequences = sc.sequences || []).push({ name: s.name });
    });
    const schemaArr = Object.keys(schemas)
      .map((k) => schemas[k])
      .sort((a, b) => a.name.localeCompare(b.name));
    out.push({ name, schemas: schemaArr });
  }
  return { databases: out };
}

function doQuery(conn, sql, params) {
  audit('query', conn.connId || conn.type, sql);
  return withLock(conn, () => (params && params.length ? conn.queryParams(sql, params) : conn.query(sql)));
}
function doExecute(conn, sql, params) {
  audit('execute', conn.connId || conn.type, sql);
  return withLock(conn, () => conn.queryParams(sql, params));
}

// 表完整定义（供表设计器与 SQL 提示）：含类型长度/精度、NOT NULL、默认值、PK、注释
async function _tableDefCore(conn, schema, table) {
    const col = await conn.queryParams(
      `SELECT c.column_name, c.data_type, c.character_maximum_length,
              c.numeric_precision, c.numeric_scale, c.is_nullable, c.column_default,
              pgd.description AS comment
       FROM information_schema.columns c
       LEFT JOIN pg_catalog.pg_statio_all_tables st ON c.table_schema = st.schemaname AND c.table_name = st.relname
       LEFT JOIN pg_catalog.pg_description pgd ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
       WHERE c.table_schema = $1 AND c.table_name = $2 ORDER BY c.ordinal_position`,
      [schema, table]
    );
    const pk = await conn.queryParams(
      `SELECT kcu.column_name FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema AND tc.table_name = kcu.table_name
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
      [schema, table]
    );
    const pkSet = new Set(pk.rows.map((r) => r.column_name));
    const columns = col.rows.map((c) => ({
      name: c.column_name,
      type: formatPgType(c.data_type, c.character_maximum_length, c.numeric_precision, c.numeric_scale),
      baseType: c.data_type,
      nullable: c.is_nullable === 'YES',
      default: c.column_default == null ? null : String(c.column_default),
      pk: pkSet.has(c.column_name),
      comment: c.comment == null ? '' : String(c.comment),
    }));
    // 索引（含列聚合）
    const idx = await conn.queryParams(
      `SELECT i.relname AS index_name, ix.indisunique AS is_unique, am.amname AS method,
              (SELECT array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum))
               FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)) AS cols
       FROM pg_class t
       JOIN pg_index ix ON ix.indrelid = t.oid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_am am ON am.oid = i.relam
       WHERE t.relname = $2 AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
       ORDER BY i.relname`,
      [schema, table]
    );
    const indexes = idx.rows.map((r) => ({
      name: r.index_name,
      unique: r.is_unique === true || r.is_unique === 't' || r.is_unique === 'true',
      method: r.method,
      columns: parsePgArray(r.cols),
    }));
    // 外键（含多列聚合）
    const fk = await conn.queryParams(
      `SELECT tc.constraint_name, kcu.column_name AS local_column, ccu.table_name AS ref_table,
              ccu.column_name AS ref_column, rc.delete_rule, rc.update_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema AND tc.table_name = kcu.table_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2
       ORDER BY tc.constraint_name`,
      [schema, table]
    );
    const fkMap = new Map();
    for (const r of fk.rows) {
      if (!fkMap.has(r.constraint_name)) {
        fkMap.set(r.constraint_name, { name: r.constraint_name, localColumns: [], refTable: r.ref_table, refColumns: [], onDelete: r.delete_rule, onUpdate: r.update_rule });
      }
      const o = fkMap.get(r.constraint_name);
      o.localColumns.push(r.local_column); o.refColumns.push(r.ref_column);
    }
    const foreignKeys = Array.from(fkMap.values());
    return { schema, table, columns, pk: Array.from(pkSet), indexes, foreignKeys };
}
async function doTableDef(conn, schema, table) {
  if (conn.type === 'sqlite') {
    return withLock(conn, async () => {
      const cols = (await conn.query('PRAGMA table_info(' + JSON.stringify(table) + ')')).rows.map((c) => ({
        name: c.name, type: c.type || 'text', baseType: c.type || 'text',
        nullable: c.notnull !== 1, default: c.dflt_value == null ? null : String(c.dflt_value),
        pk: c.pk > 0, comment: '',
      }));
      const pkCols = cols.filter((c) => c.pk).map((c) => c.name);
      return { schema: 'main', table, columns: cols, pk: pkCols, indexes: [], foreignKeys: [] };
    });
  }
  if (conn._mysql) {
    return withLock(conn, async () => {
      const sch = schema || conn.database || 'mysql';
      const cols = (await conn.query(
        `SELECT column_name AS cname, data_type AS dtype, character_maximum_length AS clen, numeric_precision AS nprec, numeric_scale AS nscale,
                is_nullable AS inull, column_default AS cdef, column_key AS ckey, column_comment AS ccomment
         FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
        [sch, table]
      )).rows.map((c) => ({
        name: c.cname, type: c.dtype || 'text',
        baseType: c.dtype || 'text',
        nullable: c.inull === 'YES', default: c.cdef == null ? null : String(c.cdef),
        pk: c.ckey === 'PRI', comment: c.ccomment || '',
      }));
      const pkCols = cols.filter((c) => c.pk).map((c) => c.name);
      return { schema: sch, table, columns: cols, pk: pkCols, indexes: [], foreignKeys: [] };
    });
  }
  return withLock(conn, () => _tableDefCore(conn, schema, table));
}

// 跨库数据传输：读源表定义+数据，写入目标连接（PG/SQLite/MySQL 之间尽力）
async function _transferCore(src, dst, schema, table, dstTable, includeData, dropFirst, dstDb) {
  const target = dstTable || table;
  // 目标表全名：目标库不同时用库前缀（跨库引用，PG: "dstDb"."schema"."table"；MySQL: `dstDb`.`table`）
  const tq = (s) => (dst._mysql ? '`' + String(s).replace(/`/g, '``') + '`' : qi(s));
  const targetRef = (dstDb && dstDb !== dst.database)
    ? (dst._mysql ? tq(dstDb) + '.' + tq(target) : tq(dstDb) + '.' + tq(target))
    : tq(target);
  let def;
  if (src.type === 'sqlite') {
    const c = (await src.query('PRAGMA table_info(' + JSON.stringify(table) + ')')).rows.map((x) => ({ name: x.name, type: x.type || 'text', nullable: x.notnull !== 1, pk: x.pk > 0, default: x.dflt_value }));
    def = { columns: c, pk: c.filter((x) => x.pk).map((x) => x.name) };
  } else if (src._mysql) {
    const sch = schema || src.database || 'mysql';
    const c = (await src.query(
      `SELECT column_name AS cname, data_type AS dtype, is_nullable AS inull, column_key AS ckey
       FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, [sch, table]
    )).rows.map((x) => ({ name: x.cname, type: x.dtype || 'text', nullable: x.inull === 'YES', pk: x.ckey === 'PRI', default: null }));
    def = { columns: c, pk: c.filter((x) => x.pk).map((x) => x.name) };
  } else {
    def = await _tableDefCore(src, schema, table);
  }
  let colSql, pkSql = '';
  // 跨方言类型映射：源库类型 → 目标方言（PG ↔ MySQL ↔ SQLite 之间互相传输时类型兼容）
  // 支持长度解析：varchar(50) → VARCHAR(50)；无长度 varchar → TEXT（避免 255 截断 Data too long）
  const mapType = (t) => {
    const raw = String(t || 'text');
    const m = /^([a-z_ ]+?)\s*\((\d+)\)/i.exec(raw);
    const base = (m ? m[1] : raw).toLowerCase().split(' ')[0];
    const len = m ? parseInt(m[2], 10) : null;
    if (dst.type === 'sqlite') {
      // → SQLite
      if (/int|serial|bigint|smallint|integer/i.test(base)) return 'INTEGER';
      if (/real|double|float|numeric|decimal|money/i.test(base)) return 'REAL';
      if (/boolean|bool/i.test(base)) return 'INTEGER';
      if (/timestamp|date|time/i.test(base)) return 'TEXT';
      if (/json|bytea|blob/i.test(base)) return 'BLOB';
      return 'TEXT';
    }
    if (dst._mysql) {
      // → MySQL
      if (/smallint/i.test(base)) return 'SMALLINT';
      if (/bigint/i.test(base)) return 'BIGINT';
      if (/serial/i.test(base)) return 'BIGINT AUTO_INCREMENT';
      if (/integer|int/i.test(base)) return 'INT';
      if (/numeric|decimal/i.test(base)) return len ? ('DECIMAL(' + Math.min(len, 65) + ',6)') : 'DECIMAL(20,6)';
      if (/money/i.test(base)) return 'DECIMAL(20,6)';
      if (/real|double/i.test(base)) return 'DOUBLE';
      if (/float/i.test(base)) return 'FLOAT';
      if (/boolean|bool/i.test(base)) return 'TINYINT(1)';
      if (/timestamp|timestamptz/i.test(base)) return 'DATETIME(3)';
      if (/date/i.test(base)) return 'DATE';
      if (/time/i.test(base)) return 'TIME';
      if (/json/i.test(base)) return 'JSON';
      if (/bytea/i.test(base)) return 'LONGBLOB';
      if (/blob/i.test(base)) return 'LONGBLOB';
      if (/varchar|character varying|char/i.test(base)) return len ? ('VARCHAR(' + Math.min(len, 2000) + ')') : 'TEXT';
      if (/text|citext/i.test(base)) return 'TEXT';
      if (/uuid/i.test(base)) return 'VARCHAR(36)';
      if (/inet|cidr/i.test(base)) return 'VARCHAR(64)';
      if (/array/i.test(base)) return 'JSON';
      return 'TEXT';
    }
    // → PG：MySQL/SQLite 类型转 PG
    if (/tinyint|bool/i.test(base)) return 'BOOLEAN';
    if (/bigint/i.test(base) && !/int4/i.test(base)) return 'BIGINT';
    if (/int|integer|mediumint|tinyint/i.test(base) && !/bigint/i.test(base)) return 'INTEGER';
    if (/serial/i.test(base)) return 'BIGSERIAL';
    if (/double/i.test(base)) return 'DOUBLE PRECISION';
    if (/float|real/i.test(base)) return 'REAL';
    if (/decimal|numeric/i.test(base)) return 'NUMERIC';
    if (/datetime|timestamp/i.test(base)) return 'TIMESTAMP';
    if (/blob|longblob/i.test(base)) return 'BYTEA';
    if (/json/i.test(base)) return 'JSONB';
    if (/varchar|char/i.test(base)) return len ? ('VARCHAR(' + len + ')') : 'TEXT';
    if (/text/i.test(base)) return 'TEXT';
    return 'TEXT';
  };
  // 跨方言 DEFAULT 清理：PG 默认值表达式(如 'x'::character varying / nextval(...))MySQL 不认，丢弃或转换
  const mapDefault = (d, c) => {
    if (d == null || d === '') return null;
    const s = String(d);
    if (src.type !== 'sqlite' && src._mysql !== dst._mysql && !(src._mysql && dst.type === 'sqlite')) {
      // 跨方言（PG↔MySQL / PG↔SQLite）：丢弃 PG 专有默认值（含 ::type 类型转换、nextval 序列、函数调用）
      if (/::|nextval|gen_random_uuid|uuid_generate|now\(\)|CURRENT_|clock_timestamp|random\(\)/i.test(s)) return null;
      // 数字/布尔字面量保留；字符串字面量保留（去掉外层引号差异交给目标库）
      if (/^[+-]?\d+(\.\d+)?$/.test(s)) return s;
      if (/^true$/i.test(s)) return dst._mysql ? '1' : 'TRUE';
      if (/^false$/i.test(s)) return dst._mysql ? '0' : 'FALSE';
      if (/^'.*'$/s.test(s)) return s;
      return null;
    }
    return s;
  };
  if (dst.type === 'sqlite') {
    colSql = def.columns.map((c) => qi(c.name) + ' ' + mapType(c.type) + (c.pk ? ' PRIMARY KEY' : '') + (c.nullable ? '' : ' NOT NULL')).join(', ');
  } else {
    colSql = def.columns.map((c) => {
      const defv = mapDefault(c.default, c);
      return qi(c.name) + ' ' + mapType(c.type) + (defv ? ' DEFAULT ' + defv : '') + (c.nullable ? '' : ' NOT NULL');
    }).join(', ');
    if (def.pk.length) pkSql = ', PRIMARY KEY (' + def.pk.map(qi).join(', ') + ')';
  }
  if (dropFirst) await dst.queryParams('DROP TABLE IF EXISTS ' + targetRef, []);
  await dst.queryParams('CREATE TABLE ' + (dropFirst ? '' : 'IF NOT EXISTS ') + targetRef + ' (' + colSql + pkSql + ')', []);
  let rows = 0;
  if (includeData) {
    const cols = def.columns.map((c) => c.name);
    const bq = (s) => (src._mysql ? '`' + String(s).replace(/`/g, '``') + '`' : qi(s));
    const srcTable = src.type === 'sqlite' ? qi(table) : (bq(schema) + '.' + bq(table));
    const order = def.pk.length ? ' ORDER BY ' + def.pk.map(bq).join(', ') : (src.type === 'sqlite' ? ' ORDER BY rowid' : (src._mysql ? '' : ' ORDER BY ctid'));
    for (let off = 0; ; off += 1000) {
      const r = await src.query('SELECT * FROM ' + srcTable + order + ' LIMIT 1000 OFFSET ' + off);
      if (!r.rows.length) break;
      for (const row of r.rows) {
        const params = cols.map((cn) => (row[cn] === undefined ? null : row[cn]));
        const sql = 'INSERT INTO ' + targetRef + ' (' + cols.map(qi).join(', ') + ') VALUES (' + cols.map((_, i) => '$' + (i + 1)).join(', ') + ')';
        await dst.queryParams(sql, params);
        rows++;
      }
    }
  }
  return { table: target, rows };
}
async function doTransfer(srcConn, dstConn, schema, table, dstTable, includeData, dropFirst, dstDb) {
  // 目标库不同（PG/MySQL 多库场景）：用 dstDb 建目标库连接再传（复用 connect-db 逻辑）
  if (dstDb && dstDb !== dstConn.database && dstConn.type !== 'sqlite') {
    if (!dstConn._cfg) {
      // 无凭据（不支持按库切换）：降级为目标表加库前缀直接引用（跨库在目标连接上完成）
      return withLock(srcConn, () => withLock(dstConn, () => _transferCore(srcConn, dstConn, schema, table, dstTable, includeData, dropFirst, dstDb)));
    }
    try {
      const targetConn = await connectDbInternal(dstConn, dstDb);
      try { return await withLock(srcConn, () => withLock(targetConn, () => _transferCore(srcConn, targetConn, schema, table, dstTable, includeData, dropFirst))); }
      finally { try { targetConn.end(); } catch (_) {} }
    } catch (e) {
      // 建目标库连接失败（权限/库不存在）：降级为库前缀引用
      return withLock(srcConn, () => withLock(dstConn, () => _transferCore(srcConn, dstConn, schema, table, dstTable, includeData, dropFirst, dstDb)));
    }
  }
  return withLock(srcConn, () => withLock(dstConn, () => _transferCore(srcConn, dstConn, schema, table, dstTable, includeData, dropFirst)));
}

// 导出表 SQL：结构 DDL（CREATE TABLE/COMMENT/INDEX/FK）+ 可选数据 INSERT（分批）
const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';
async function doExportSql(conn, schema, table, includeData) {
  if (conn.type === 'sqlite') {
    return withLock(conn, async () => {
      const cr = (await conn.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=" + JSON.stringify(table))).rows || [];
      const lines = [];
      if (cr.length && cr[0].sql) lines.push(cr[0].sql + ';');
      let rows = 0;
      if (includeData) {
        const cols = (await conn.query('PRAGMA table_info(' + JSON.stringify(table) + ')')).rows.map((c) => c.name);
        for (let off = 0; ; off += 2000) {
          const r = await conn.query('SELECT * FROM ' + JSON.stringify(table) + ' ORDER BY rowid LIMIT 2000 OFFSET ' + off);
          if (!r.rows.length) break;
          for (const row of r.rows) {
            const vals = cols.map((cn) => {
              const v = row[cn];
              if (v == null) return 'NULL';
              if (typeof v === 'number') return String(v);
              if (typeof v === 'boolean') return v ? '1' : '0';
              return "'" + String(v).replace(/'/g, "''") + "'";
            });
            lines.push('INSERT INTO ' + JSON.stringify(table) + ' (' + cols.map((x) => JSON.stringify(x)).join(', ') + ') VALUES (' + vals.join(', ') + ');');
            rows++;
          }
        }
      }
      lines.unshift('-- 导出 SQLite 表 ' + table + ' · ' + (includeData ? '结构+数据' : '仅结构') + ' · ' + rows + ' 行');
      return { filename: table + (includeData ? '_data.sql' : '_ddl.sql'), content: lines.join('\n') + '\n', rows };
    });
  }
  return withLock(conn, async () => {
    if (conn._mysql) {
      const sch = schema || conn.database || 'mysql';
      const cols = (await conn.query(
        `SELECT column_name AS cname, data_type AS dtype, character_maximum_length AS clen, is_nullable AS inull, column_key AS ckey, column_comment AS ccomment, column_default AS cdef
         FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, [sch, table]
      )).rows.map((c) => ({ name: c.cname, type: c.dtype || 'text', nullable: c.inull === 'YES', pk: c.ckey === 'PRI', default: c.cdef == null ? null : String(c.cdef), comment: c.ccomment || '' }));
      const pkCols = cols.filter((c) => c.pk).map((c) => c.name);
      const lines = ['-- 导出 MySQL 表 ' + sch + '.' + table + (includeData ? ' · 结构+数据' : ' · 仅结构')];
      lines.push('CREATE TABLE `' + table + '` (');
      lines.push(cols.map((c) => '  `' + c.name + '` ' + c.type + (c.nullable ? '' : ' NOT NULL') + (c.default != null ? ' DEFAULT ' + c.default : '')).join(',\n'));
      if (pkCols.length) lines.push('  PRIMARY KEY (`' + pkCols.join('`,`') + '`)');
      lines.push(');');
      let rows = 0;
      if (includeData) {
        const nameList = cols.map((c) => '`' + c.name + '`').join(', ');
        for (let off = 0; ; off += 2000) {
          const r = await conn.query('SELECT * FROM `' + table + '`' + (pkCols.length ? ' ORDER BY `' + pkCols.join('`,`') + '`' : '') + ' LIMIT 2000 OFFSET ' + off);
          if (!r.rows.length) break;
          for (const row of r.rows) {
            const vals = cols.map((c) => { const v = row[c.name]; if (v == null) return 'NULL'; if (typeof v === 'number') return String(v); if (v instanceof Date) return "'" + v.toISOString().slice(0, 19).replace('T', ' ') + "'"; return "'" + String(v).replace(/'/g, "''") + "'"; });
            lines.push('INSERT INTO `' + table + '` (' + nameList + ') VALUES (' + vals.join(', ') + ');');
            rows++;
          }
        }
      }
      lines.push('-- ' + rows + ' 行');
      return { filename: table + (includeData ? '_data.sql' : '_ddl.sql'), content: lines.join('\n') + '\n', rows };
    }
    const def = await _tableDefCore(conn, schema, table);
    const lines = [];
    const colDefs = def.columns.map((c) => {
      let s = '  ' + qi(c.name) + ' ' + c.type;
      if (c.default && c.default !== '') s += ' DEFAULT ' + c.default;
      if (!c.nullable) s += ' NOT NULL';
      return s;
    });
    if (def.pk.length) colDefs.push('  PRIMARY KEY (' + def.pk.map(qi).join(', ') + ')');
    lines.push('CREATE TABLE ' + qi(schema) + '.' + qi(table) + ' (');
    lines.push(colDefs.join(',\n'));
    lines.push(');');
    def.columns.forEach((c) => { if (c.comment) lines.push('COMMENT ON COLUMN ' + qi(schema) + '.' + qi(table) + '.' + qi(c.name) + ' IS ' + "'" + c.comment.replace(/'/g, "''") + "';"); });
    (def.indexes || []).forEach((ix) => {
      const isPk = ix.name === table + '_pkey' && def.pk.length && (ix.columns || []).join(',') === def.pk.join(',');
      if (isPk) return;
      lines.push('CREATE ' + (ix.unique ? 'UNIQUE ' : '') + 'INDEX ' + qi(ix.name) + ' ON ' + qi(schema) + '.' + qi(table) + ' USING ' + (ix.method || 'btree') + ' (' + ix.columns.map(qi).join(', ') + ');');
    });
    (def.foreignKeys || []).forEach((fk) => {
      const ref = fk.refTable.indexOf('.') < 0 ? (qi(schema) + '.' + qi(fk.refTable)) : fk.refTable.split('.').map(qi).join('.');
      lines.push('ALTER TABLE ' + qi(schema) + '.' + qi(table) + ' ADD CONSTRAINT ' + qi(fk.name) + ' FOREIGN KEY (' + fk.localColumns.map(qi).join(', ') + ') REFERENCES ' + ref + ' (' + fk.refColumns.map(qi).join(', ') + ') ON DELETE ' + fk.onDelete + ' ON UPDATE ' + fk.onUpdate + ';');
    });
    let rows = 0;
    if (includeData) {
      const cols = def.columns.map((c) => c.name);
      const order = def.pk.length ? ' ORDER BY ' + def.pk.map(qi).join(', ') : ' ORDER BY ctid';
      for (let off = 0; ; off += 2000) {
        const r = await conn.query('SELECT * FROM ' + qi(schema) + '.' + qi(table) + order + ' LIMIT 2000 OFFSET ' + off);
        if (!r.rows.length) break;
        for (const row of r.rows) {
          const vals = cols.map((cn) => {
            const v = row[cn];
            if (v == null) return 'NULL';
            if (typeof v === 'number') return String(v);
            if (v === true) return 'TRUE'; if (v === false) return 'FALSE';
            return "'" + String(v).replace(/'/g, "''") + "'";
          });
          lines.push('INSERT INTO ' + qi(schema) + '.' + qi(table) + ' (' + cols.map(qi).join(', ') + ') VALUES (' + vals.join(', ') + ');');
          rows++;
        }
      }
    }
    lines.unshift('-- 导出 ' + schema + '.' + table + ' · ' + (includeData ? '结构+数据' : '仅结构') + ' · ' + rows + ' 行数据');
    return { filename: table + (includeData ? '_data.sql' : '_ddl.sql'), content: lines.join('\n') + '\n', rows };
  });
}
// 库级导出：遍历库内所有 schema 的所有表，逐表导出拼接为一个 .sql 文件（Navicat 转储 SQL 文件）
// mode: 'structure' | 'data' | 'both'
async function doExportDbSql(conn, dbName, mode) {
  const includeData = mode !== 'structure';
  const includeDdl = mode !== 'data';
  // 获取库内所有表（列表来自 metadata）
  const dbMeta = conn.meta && conn.meta.databases ? (conn.meta.databases.find((d) => d.name === dbName) || null) : null;
  if (!dbMeta) return { filename: '', content: '', rows: 0, error: '库元数据未加载，请先刷新' };
  const parts = [];
  let totalRows = 0, tableCount = 0;
  const schemas = (dbMeta.schemas || []).filter((s) => !(s.name === dbName)); // 平铺库的 schema 即库本身，跳过
  const realSchemas = schemas.length ? schemas : [dbMeta];
  for (const sc of realSchemas) {
    const tables = (sc.tables || []);
    const views = (sc.views || []);
    for (const t of tables) {
      try {
        const r = await doExportSql(conn, sc.name, t.name, includeData && mode === 'both');
        if (includeDdl) parts.push(r.content);
        totalRows += r.rows; tableCount++;
      } catch (_) { /* 单表失败跳过 */ }
    }
    for (const v of views) {
      // 视图导出 DDL（如有）
      try { parts.push('-- 视图 ' + sc.name + '.' + v.name + '\n'); } catch (_) {}
    }
  }
  const head = '-- 数据库转储: ' + dbName + ' · ' + (mode === 'structure' ? '仅结构' : mode === 'data' ? '仅数据' : '结构和数据') + ' · ' + tableCount + ' 张表 · ' + totalRows + ' 行\n';
  const content = head + '\n' + parts.join('\n') + '\n';
  const fname = dbName + '_' + (mode === 'structure' ? 'structure' : mode === 'data' ? 'data' : 'full') + '.sql';
  return { filename: fname, content, rows: totalRows, tables: tableCount };
}
// 解析 PG 数组文本（{a,b}）为 JS 数组；兼容已解析的数组/标量
function parsePgArray(s) {
  if (Array.isArray(s)) return s;
  if (s == null) return [];
  if (typeof s !== 'string') return [String(s)];
  const t = s.trim();
  if (t.length >= 2 && t[0] === '{' && t[t.length - 1] === '}') {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((x) => x.replace(/^"|"$/g, '').trim()).filter(Boolean);
  }
  return [t];
}
function formatPgType(dt, len, prec, scale) {
  switch (dt) {
    case 'character varying': return len != null ? 'varchar(' + len + ')' : 'varchar';
    case 'character': return len != null ? 'char(' + len + ')' : 'char';
    case 'numeric':
    case 'decimal': return prec != null ? 'numeric(' + prec + (scale != null ? ',' + scale : '') + ')' : 'numeric';
    case 'time without time zone': return 'time';
    case 'time with time zone': return 'timetz';
    case 'timestamp without time zone': return 'timestamp';
    case 'timestamp with time zone': return 'timestamptz';
    case 'double precision': return 'float8';
    case 'bit varying': return len != null ? 'varbit(' + len + ')' : 'varbit';
    default: return dt;
  }
}

// 执行计划（EXPLAIN）
async function doExplain(conn, sql, analyze) {
  return withLock(conn, async () => {
    const mode = analyze ? 'EXPLAIN ANALYZE' : 'EXPLAIN (FORMAT JSON)';
    let plan = null, text = '';
    try {
      const r = await conn.query(mode + ' ' + sql);
      if (r.rows && r.rows.length && r.rows[0].hasOwnProperty('QUERY PLAN')) {
        const qp = r.rows[0]['QUERY PLAN'];
        plan = (Array.isArray(qp) || (qp && typeof qp === 'object')) ? qp : null;
        text = typeof qp === 'string' ? qp : JSON.stringify(qp, null, 2);
      } else {
        // 纯文本 EXPLAIN 路径
        plan = r.rows.length ? r.rows[0]['QUERY PLAN'] || r.rows[0] : null;
        text = JSON.stringify(plan, null, 2);
      }
    } catch (e) {
      // 某些语句不支持 FORMAT JSON，退回纯文本 EXPLAIN
      const r2 = await conn.query('EXPLAIN ' + sql);
      text = r2.rows.map((x) => x['QUERY PLAN']).join('\n');
    }
    return { plan, text };
  });
}

// 角色 / 用户权限
async function doRoles(conn) {
  return withLock(conn, async () => {
    const r = await conn.query(
      `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
              rolconnlimit, rolvaliduntil
       FROM pg_roles
       WHERE rolname NOT LIKE 'pg_%'
       ORDER BY rolcanlogin DESC, rolname`
    );
    return { roles: r.rows };
  });
}

// 服务器监控
async function doMonitor(conn) {
  return withLock(conn, async () => {
    const act = await conn.query(
      `SELECT pid, usename, application_name, client_addr, state, wait_event_type, wait_event,
              query_start, LEFT(query, 90) AS query
       FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
       ORDER BY query_start NULLS LAST`
    );
    const db = await conn.query(
      `SELECT datname, numbackends, xact_commit, xact_rollback, blks_read, blks_hit,
              tup_returned, tup_inserted, tup_updated, tup_deleted, deadlocks, conflicts
       FROM pg_stat_database
       WHERE datname IS NOT NULL AND datname NOT LIKE 'template%'
       ORDER BY datname`
    );
    return { activity: act.rows, dbstats: db.rows };
  });
}

// kill 会话（PG: pg_terminate_backend；MySQL: KILL 连接 id）
async function doKillSession(conn, pid) {
  audit('kill', conn.connId || conn.type, 'pid=' + pid);
  return withLock(conn, async () => {
    if (conn._mysql) return conn.query('KILL ?', [pid]);
    return conn.queryParams('SELECT pg_terminate_backend($1) AS killed', [pid]);
  });
}

// 审计日志查询
function doAudit() {
  return { logs: AUDIT.slice().reverse() };
}

// 结构同步：比对两端表定义 → 生成差异脚本（当前支持同族同结构比较，跨库尽力）
async function doStructureSync(srcConn, dstConn, schema, table, dstSchema, dstTable) {
  audit('sync-structure', srcConn.connId || srcConn.type, schema + '.' + table + ' -> ' + (dstSchema || schema) + '.' + (dstTable || table));
  const tSchema = dstSchema || schema, tTable = dstTable || table;
  const readDef = async (conn, sch, tbl) => {
    if (conn.type === 'sqlite') {
      const cols = (await conn.query('PRAGMA table_info(' + JSON.stringify(tbl) + ')')).rows.map((c) => ({ name: c.name, type: c.type || 'text', nullable: c.notnull !== 1, pk: c.pk > 0, default: c.dflt_value == null ? null : String(c.dflt_value) }));
      return { columns: cols, pk: cols.filter((c) => c.pk).map((c) => c.name) };
    }
    if (conn._mysql) {
      const sch2 = sch || conn.database || 'mysql';
      const cols = (await conn.query(
        `SELECT column_name AS n, data_type AS t, is_nullable AS nl, column_key AS ck, column_default AS cd
         FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, [sch2, tbl]
      )).rows.map((c) => ({ name: c.n, type: c.t, nullable: c.nl === 'YES', pk: c.ck === 'PRI', default: c.cd == null ? null : String(c.cd) }));
      return { columns: cols, pk: cols.filter((c) => c.pk).map((c) => c.name) };
    }
    return _tableDefCore(conn, sch, tbl);
  };
  const [src, dst] = await Promise.all([readDef(srcConn, schema, table), readDef(dstConn, tSchema, tTable)]);
  const scripts = [];
  const srcCols = src.columns || [], dstCols = dst.columns || [];
  const dstMap = {}; dstCols.forEach((c) => { dstMap[c.name] = c; });
  // 缺表：生成 CREATE
  if (!dstCols.length) {
    const lines = ['CREATE TABLE ' + qi(tSchema) + '.' + qi(tTable) + ' ('];
    const colDefs = srcCols.map((c) => '  ' + qi(c.name) + ' ' + c.type + (c.default != null ? ' DEFAULT ' + c.default : '') + (c.nullable ? '' : ' NOT NULL'));
    if (src.pk.length) colDefs.push('  PRIMARY KEY (' + src.pk.map(qi).join(', ') + ')');
    lines.push(colDefs.join(',\n'));
    lines.push(');');
    scripts.push(lines.join('\n'));
    return { exists: false, scripts, diff: ['目标表不存在 → 生成 CREATE TABLE'] };
  }
  // 已有表：列差异 → ALTER
  const diff = [];
  srcCols.forEach((c) => {
    const d = dstMap[c.name];
    if (!d) {
      diff.push('目标缺列 ' + c.name + ' (' + c.type + ')');
      scripts.push('ALTER TABLE ' + qi(tSchema) + '.' + qi(tTable) + ' ADD COLUMN ' + qi(c.name) + ' ' + c.type + (c.nullable ? '' : ' NOT NULL') + (c.default != null ? ' DEFAULT ' + c.default : '') + ';');
    } else {
      if ((d.type || '').toLowerCase() !== (c.type || '').toLowerCase()) {
        diff.push('列 ' + c.name + ' 类型不同: ' + d.type + ' → ' + c.type);
        scripts.push('ALTER TABLE ' + qi(tSchema) + '.' + qi(tTable) + ' ALTER COLUMN ' + qi(c.name) + ' TYPE ' + c.type + ';');
      }
      if (d.nullable === true && c.nullable === false) {
        diff.push('列 ' + c.name + ' 需改为 NOT NULL');
        scripts.push('ALTER TABLE ' + qi(tSchema) + '.' + qi(tTable) + ' ALTER COLUMN ' + qi(c.name) + ' SET NOT NULL;');
      }
    }
  });
  if (!diff.length) return { exists: true, scripts: [], diff: ['两端结构一致，无差异'] };
  return { exists: true, scripts, diff };
}

// 数据同步：按主键比对 → 生成 INSERT/UPDATE/DELETE 合并脚本
async function doDataSync(srcConn, dstConn, schema, table, dstSchema, dstTable) {
  audit('sync-data', srcConn.connId || srcConn.type, schema + '.' + table + ' -> ' + (dstSchema || schema) + '.' + (dstTable || table));
  const tSchema = dstSchema || schema, tTable = dstTable || table;
  const srcFull = (schema ? qi(schema) + '.' : '') + qi(table);
  const dstFull = (tSchema ? qi(tSchema) + '.' : '') + qi(tTable);
  const readPk = async (conn, sch, tbl) => {
    if (conn.type === 'sqlite') return (await conn.query('PRAGMA table_info(' + JSON.stringify(tbl) + ')')).rows.filter((c) => c.pk > 0).map((c) => c.name);
    if (conn._mysql) return (await conn.query('SELECT column_name AS n FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_key = ?', [sch, tbl, 'PRI'])).rows.map((r) => r.n);
    const r = await conn.queryParams(
      `SELECT kcu.column_name AS n FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'`, [sch, tbl]);
    return r.rows.map((x) => x.n);
  };
  const [srcPk, dstPk] = await Promise.all([readPk(srcConn, schema, table), readPk(dstConn, tSchema, tTable)]);
  if (!srcPk.length || !dstPk.length) return { ok: false, message: '两端表都需有主键才能做数据同步', scripts: [], stats: {} };
  const allCols = [];
  if (srcConn._mysql || srcConn.type === 'sqlite') {
    const def = srcConn._mysql ? (await srcConn.query('SELECT column_name AS n FROM information_schema.columns WHERE table_schema = ? AND table_name = ?', [schema, table])).rows.map((r) => r.n) : (await srcConn.query('PRAGMA table_info(' + JSON.stringify(table) + ')')).rows.map((c) => c.name);
    allCols.push(...def);
  } else {
    const r = await srcConn.queryParams('SELECT column_name AS n FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', [schema, table]);
    allCols.push(...r.rows.map((x) => x.n));
  }
  const key = (row, pk) => pk.map((k) => String(row[k] == null ? '' : row[k])).join('\u0001');
  const srcRows = (await srcConn.query('SELECT * FROM ' + srcFull)).rows;
  const dstRows = (await dstConn.query('SELECT * FROM ' + dstFull)).rows;
  const dstByKey = new Map(); dstRows.forEach((r) => dstByKey.set(key(r, dstPk), r));
  const srcByKey = new Map(); srcRows.forEach((r) => srcByKey.set(key(r, srcPk), r));
  const val = (v) => (v == null ? 'NULL' : (typeof v === 'number' ? String(v) : (v instanceof Date ? "'" + v.toISOString().replace('T', ' ').slice(0, 19) + "'" : "'" + String(v).replace(/'/g, "''") + "'")));
  const scripts = []; const stats = { insert: 0, update: 0, del: 0 };
  const genIns = (r) => 'INSERT INTO ' + dstFull + ' (' + allCols.map(qi).join(', ') + ') VALUES (' + allCols.map((c) => val(r[c])).join(', ') + ');';
  const genUpd = (r, d) => {
    const sets = allCols.filter((c) => !dstPk.includes(c) && String(r[c] ?? '') !== String(d[c] ?? '')).map((c) => qi(c) + ' = ' + val(r[c]));
    if (!sets.length) return null;
    return 'UPDATE ' + dstFull + ' SET ' + sets.join(', ') + ' WHERE ' + dstPk.map((k) => qi(k) + ' = ' + val(r[k])).join(' AND ') + ';';
  };
  const genDel = (r) => 'DELETE FROM ' + dstFull + ' WHERE ' + dstPk.map((k) => qi(k) + ' = ' + val(r[k])).join(' AND ') + ';';
  srcRows.forEach((r) => {
    const k = key(r, srcPk);
    if (dstByKey.has(k)) { const u = genUpd(r, dstByKey.get(k)); if (u) { scripts.push(u); stats.update++; } }
    else { scripts.push(genIns(r)); stats.insert++; }
  });
  dstRows.forEach((r) => { if (!srcByKey.has(key(r, dstPk))) { scripts.push(genDel(r)); stats.del++; } });
  return { ok: true, scripts, stats, srcCount: srcRows.length, dstCount: dstRows.length };
}

// 表设计器 DDL 落库
async function doDesignerApply(conn, sql) {
  return withLock(conn, () => conn.queryParams(sql, []));
}

// 大表导出（CSV / SQL INSERT）
async function doExport(conn, sql, format) {
  return withLock(conn, async () => {
    const r = await conn.query(sql);
    if (format === 'sql') {
      // 需要从 sql 推断表名做 INSERT；简单处理：交给前端传入 table 元信息不现实，这里回退为 CSV
      format = 'csv';
    }
    const cols = r.fields.map((f) => f.name);
    const escC = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    let out = cols.join(',') + '\n';
    r.rows.forEach((row) => { out += cols.map((c) => escC(row[c])).join(',') + '\n'; });
    return { name: 'export.csv', content: out, rows: r.rows.length, cols };
  });
}

// CSV 解析（支持引号转义）
function parseCsv(text) {
  const rows = []; let i = 0; const n = text.length;
  let row = [], field = '', inQ = false;
  while (i < n) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; if (text[i] === '\r') i++; continue; }
    if (ch === '\r') { row.push(field); rows.push(row); row = []; field = ''; i++; if (text[i] === '\n') i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && !(r.length === 1 && r[0] === ''));
}

// 推断列类型
function inferPgType(values) {
  let allInt = true, allNum = true, allBool = true, maxLen = 0, allDate = true;
  values.forEach((v) => {
    if (v === '' || v == null) return;
    if (!/^-?\d+$/.test(v)) allInt = false;
    if (!/^-?\d+(\.\d+)?$/.test(v)) allNum = false;
    if (v !== 'true' && v !== 'false') allBool = false;
    if (!/^\d{4}-\d{2}-\d{2}/.test(v)) allDate = false;
    if (String(v).length > maxLen) maxLen = String(v).length;
  });
  if (allBool) return 'boolean';
  if (allInt) return 'bigint';
  if (allNum) return 'numeric';
  if (allDate) return 'date';
  if (maxLen <= 255) return 'varchar(' + Math.max(50, Math.min(255, maxLen + 20)) + ')';
  return 'text';
}

// CSV 导入：可选地 CREATE TABLE，批量参数化 INSERT
async function doImport(conn, schema, table, csvText, opts) {
  return withLock(conn, async () => {
    const rows = parseCsv(csvText);
    if (!rows.length) throw new Error('CSV 为空');
    const header = opts.hasHeader ? rows[0].map((h) => h.trim()) : rows[0].map((_, i) => 'col' + (i + 1));
    const dataRows = opts.hasHeader ? rows.slice(1) : rows;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error('表名非法');
    header.forEach((h) => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(h)) throw new Error('列名非法：' + h); });
    const full = schema ? schema + '.' + table : table;
    if (opts.createIfNotExists) {
      const types = header.map((h, idx) => inferPgType(dataRows.map((r) => r[idx])));
      const cols = header.map((h, idx) => { const t = types[idx]; return h + ' ' + t; }).join(', ');
      await conn.queryParams('CREATE TABLE IF NOT EXISTS ' + full + ' (' + cols + ')', []);
    }
    // 分批批量 INSERT（每 500 行一条多值语句）
    let inserted = 0;
    const BATCH = 500;
    for (let s = 0; s < dataRows.length; s += BATCH) {
      const chunk = dataRows.slice(s, s + BATCH);
      const parts = [];
      const params = [];
      chunk.forEach((r) => {
        const ph = r.map((_, i) => '$' + (params.length + i + 1)).join(', ');
        parts.push('(' + ph + ')');
        r.forEach((v) => params.push(v === '' ? null : v));
      });
      const placeholders = chunk[0].map((_, i) => '$' + (i + 1)).join(', ');
      const sql = 'INSERT INTO ' + full + ' (' + header.join(', ') + ') VALUES ' + parts.join(', ');
      await conn.queryParams(sql, params);
      inserted += chunk.length;
    }
    return { inserted, table: full, columns: header.length };
  });
}

// 执行 SQL 文件内容（Navicat「运行 SQL 文件」）：按语句切分串行执行，跳过注释/空行
// 支持 PG 的 $$ 函数体、字符串引号、行/块注释
function splitSqlStatements(sql) {
  const stmts = [];
  let cur = '', i = 0;
  const n = sql.length;
  let inStr = null, inLine = false, inBlock = false, inDollar = null;
  while (i < n) {
    const ch = sql[i], nx = sql[i + 1];
    if (inLine) { if (ch === '\n') inLine = false; i++; continue; }
    if (inBlock) { if (ch === '*' && nx === '/') { inBlock = false; i += 2; } else i++; continue; }
    if (inDollar) { if (sql.startsWith(inDollar, i)) { cur += inDollar; i += inDollar.length; inDollar = null; } else { cur += ch; i++; } continue; }
    if (inStr) {
      cur += ch;
      if (ch === '\\' && i + 1 < n) { cur += sql[i + 1]; i += 2; continue; }
      if (ch === inStr) { if (nx === inStr) { cur += nx; i += 2; continue; } inStr = null; }
      i++; continue;
    }
    if (ch === '-' && nx === '-') { inLine = true; i += 2; continue; }
    if (ch === '/' && nx === '*') { inBlock = true; i += 2; continue; }
    if (ch === "'" || ch === '"') { inStr = ch; cur += ch; i++; continue; }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) { inDollar = m[0]; cur += m[0]; i += m[0].length; continue; }
    }
    if (ch === ';') { const t = cur.trim(); if (t) stmts.push(t); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  const tail = cur.trim(); if (tail) stmts.push(tail);
  return stmts;
}
async function doRunSqlFile(conn, sql) {
  const stmts = splitSqlStatements(sql || '');
  if (!stmts.length) return { ok: true, executed: 0, message: '无可执行语句' };
  let executed = 0, failed = 0;
  const errors = [];
  await withLock(conn, async () => {
    for (const st of stmts) {
      try { await conn.queryParams(st, []); executed++; }
      catch (e) { failed++; errors.push(st.slice(0, 80) + ' → ' + (e && e.message || e)); if (failed >= 5) break; }
    }
  });
  return { ok: failed === 0, executed, failed, errors: errors.slice(0, 5), total: stmts.length };
}

// ER：表 + 外键关系
async function doEr(conn, schema) {
  return withLock(conn, async () => {
    const tbl = await conn.queryParams(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
      [schema || 'public']
    );
    const pk = await conn.queryParams(
      `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema AND tc.table_name = kcu.table_name
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1`,
      [schema || 'public']
    );
    const fk = await conn.queryParams(
      `SELECT tc.table_name AS from_table, kcu.column_name AS from_col,
              ccu.table_name AS to_table, ccu.column_name AS to_col
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema AND tc.table_name = kcu.table_name
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`,
      [schema || 'public']
    );
    const pkMap = {};
    pk.rows.forEach((r) => { (pkMap[r.table_name] = pkMap[r.table_name] || []).push(r.column_name); });
    const tables = tbl.rows.map((t) => ({ name: t.table_name, pk: pkMap[t.table_name] || [] }));
    const links = fk.rows.map((r) => ({ from: r.from_table, fromCol: r.from_col, to: r.to_table, toCol: r.to_col }));
    return { schema: schema || 'public', tables, links };
  });
}

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.map': 'application/json',
};
const STATIC_MAP = [
  { prefix: '/preview/', base: 'preview' },
  { prefix: '/src/lib/', base: 'src/lib' },
];
function serveStatic(req, res, urlPath) {
  let rel;
  if (urlPath === '/' || urlPath === '') rel = 'preview/index.html';
  else {
    const hit = STATIC_MAP.find((m) => urlPath.startsWith(m.prefix));
    if (!hit) { res.writeHead(404); res.end('Not found'); return; }
    rel = hit.base + '/' + urlPath.slice(hit.prefix.length);
  }
  const full = path.resolve(WEBROOT, rel);
  if (!full.startsWith(WEBROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    // index.html 入口注入版本查询参数（绕过浏览器顽固缓存，让所有 vendor 资源必定重下）+ 构建号
    if (rel === 'preview/index.html' || full.endsWith('preview' + path.sep + 'index.html')) {
      const v = Date.now();
      buf = Buffer.from(String(buf)
        .replace(/window\.__BUILD__\s*=\s*["'][^"']*["']/g, 'window.__BUILD__ = ' + JSON.stringify(BUILD_ID))
        .replace(/(<script\b[^>]*\bsrc=)(["'])([^"']+?)\2/gi, (m, p, q, u) => p + q + u + '?v=' + v + q)
        .replace(/(<link\b[^>]*\bhref=)(["'])([^"']+?)\2/gi, (m, p, q, u) => p + q + u + '?v=' + v + q));
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    res.end(buf);
  });
}

// ---------- 路由 ----------
// 服务器可热重启（/api/settings 改配置后重建），handler 提取为独立函数
function handleRequest(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  // 安全：Web 服务关闭（仅桌面模式）时，只放行 Electron 窗口的内部请求（带 X-DB-Admin-Internal）
  // 防止外部浏览器/局域网直接访问端口；Web 开启（0.0.0.0/局域网）时正常放行
  if (process.env.LISTEN_HOST && process.env.LISTEN_HOST !== '0.0.0.0' && !loadWebSettings().enabled) {
    const internal = req.headers['x-db-admin-internal'];
    if (!internal) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Web 服务已关闭，仅允许桌面客户端访问' })); return; }
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-DB-Admin-Internal', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS' }); res.end(); return; }
  if (p.startsWith('/api/')) {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 5e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const r = await handleApi(p, data);
        return sendJson(res, r.status, r.data);
      } catch (e) {
        const msg = String((e && e.message) || e);
        console.error('[' + new Date().toISOString() + '] 路由异常 ' + p + ':', (e && e.stack) || e);
        sendJson(res, 500, { error: msg });
      }
    });
    return;
  }
  serveStatic(req, res, p);
}

// ---------- 设置管理（Web 服务开关/端口/监听地址） ----------
let httpServer = null; // 可热重启的 server 引用
let currentHttpPort = 5180; // 当前实际监听端口（findPort 可能选择备用端口）
// 配置路径：优先用户可写目录（%APPDATA%），安装到 Program Files 时安装目录只读
//   - 桌面端由 SETTINGS_FILE_PATH 注入；否则用 %APPDATA%\db-admin\db-admin.json
function resolveSettingsFile() {
  if (process.env.SETTINGS_FILE_PATH) return process.env.SETTINGS_FILE_PATH;
  try {
    const ap = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'db-admin');
    return path.join(ap, 'db-admin.json');
  } catch (_) {
    return path.join(__dirname, '..', 'db-admin.json');
  }
}
const SETTINGS_FILE = resolveSettingsFile();
let currentWeb = { enabled: false, host: '0.0.0.0', port: 5180 };
function loadWebSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const j = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (j && j.web) currentWeb = Object.assign({ enabled: false, host: '0.0.0.0', port: 5180 }, j.web);
    }
  } catch (_) {}
  return currentWeb;
}
function saveWebSettings(cfg) {
  currentWeb = Object.assign({ enabled: false, host: '0.0.0.0', port: 5180 }, cfg || {});
  try {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ web: currentWeb }, null, 2), 'utf8');
  } catch (e) { console.error('保存配置失败:', e.message); }
}
// GET → 返回当前配置；POST → 保存并热重启（切换 Web 开关/端口/监听地址立即生效）
function handleSettings(req, res, data) {
  if (req.method === 'GET' || req.method === 'POST' && !data.web) {
    return sendJson(res, 200, { web: loadWebSettings(), file: SETTINGS_FILE });
  }
  const cfg = data.web || {};
  const next = {
    enabled: !!cfg.enabled,
    host: String(cfg.host || '0.0.0.0').trim() || '0.0.0.0',
    port: Math.min(65535, Math.max(1, parseInt(cfg.port, 10) || 5180)),
  };
  saveWebSettings(next);
  const host = next.enabled ? next.host : '127.0.0.1';
  // 桌面窗口端口：web 关闭时保持当前端口（启动时 findPort 已选可用端口，不能写死 5180）
  const port = next.enabled ? next.port : currentHttpPort;
  // 先返回响应，再延迟热重启（避免 closeAllConnections 误杀当前请求）
  const doRestart = () => {
    if (httpServer) {
      try { httpServer.closeIdleConnections(); } catch (_) {}
      try { httpServer.closeAllConnections(); } catch (_) {}
      httpServer.close(() => {
        httpServer = http.createServer(handleRequest);
        httpServer.on('error', (e) => console.error('监听失败:', e.message));
        currentHttpPort = port;
        httpServer.listen(port, host, () => {
          console.log('配置已更新 → Web 访问: ' + (next.enabled ? ('已开启 → http://' + host + ':' + port + '/') : '关闭（仅桌面窗口可用）'));
        });
      });
    } else {
      httpServer = http.createServer(handleRequest);
      httpServer.on('error', (e) => console.error('监听失败:', e.message));
      currentHttpPort = port;
      httpServer.listen(port, host);
    }
  };
  setTimeout(doRestart, 300);
  return sendJson(res, 200, { ok: true, web: next, host, port });
}

// ---------- 统一 API 动作层：HTTP 与 Electron IPC 共用（桌面零端口模式） ----------
// 返回 { status, data }，错误统一分类(404 连接失效 / 400 SQL 错误 / 500 其他)，不抛异常
async function handleApi(p, data) {
  data = data || {};
  try {
    if (p === '/api/ping') return { status: 200, data: { ok: true } };
    if (p === '/api/build') return { status: 200, data: { build: BUILD_ID } };
    if (p === '/api/settings') {
      // 无 web 字段 = 读取；有 web 字段 = 保存(Web 模式附带热重启)
      if (!data.web) return { status: 200, data: { web: loadWebSettings(), file: SETTINGS_FILE } };
      const cfg = data.web || {};
      const next = { enabled: !!cfg.enabled, host: String(cfg.host || '0.0.0.0').trim() || '0.0.0.0', port: Math.min(65535, Math.max(1, parseInt(cfg.port, 10) || 5180)) };
      saveWebSettings(next);
      if (!process.env.DB_NEST_IPC_ONLY && httpServer) {
        // Web/HTTP 模式：保存后热重启监听
        const host = next.enabled ? next.host : '127.0.0.1';
        const port = next.enabled ? next.port : currentHttpPort;
        const doRestart = () => {
          try { httpServer.closeIdleConnections(); } catch (_) {}
          try { httpServer.closeAllConnections(); } catch (_) {}
          httpServer.close(() => {
            httpServer = http.createServer(handleRequest);
            httpServer.on('error', (e) => console.error('监听失败:', e.message));
            currentHttpPort = port;
            httpServer.listen(port, host, () => { console.log('配置已更新 → Web 访问: ' + (next.enabled ? ('已开启 → http://' + host + ':' + port + '/') : '关闭（仅桌面窗口可用）')); });
          });
        };
        setTimeout(doRestart, 300);
      }
      return { status: 200, data: { ok: true, web: next } };
    }
    if (p === '/api/connect') return { status: 200, data: await doConnect(data) };
    if (p === '/api/audit') return { status: 200, data: doAudit() };
    if (p === '/api/patch') return await handlePatch(data.action, data);
    const conn = CONNS.get(data.connId);
    if (!conn) return { status: 404, data: { error: '连接不存在或已断开，请重新连接' } };
    if (p === '/api/connect-db') return { status: 200, data: await doConnectDb(conn, data.db) };
    if (p === '/api/metadata') return { status: 200, data: await doMetadata(conn, data.db) };
    if (p === '/api/table-def') return { status: 200, data: await doTableDef(conn, data.schema, data.table) };
    if (p === '/api/query') return { status: 200, data: await doQuery(conn, data.sql, data.params || []) };
    if (p === '/api/execute') return { status: 200, data: await doExecute(conn, data.sql, data.params || []) };
    if (p === '/api/disconnect') { try { conn.end(); } catch (_) {} CONNS.delete(data.connId); return { status: 200, data: { ok: true } }; }
    if (p === '/api/explain') return { status: 200, data: await doExplain(conn, data.sql, !!data.analyze) };
    if (p === '/api/roles') return { status: 200, data: await doRoles(conn) };
    if (p === '/api/monitor') return { status: 200, data: await doMonitor(conn) };
    if (p === '/api/kill-session') return { status: 200, data: await doKillSession(conn, data.pid) };
    if (p === '/api/sync-structure') {
      const dst = CONNS.get(data.dstConnId);
      if (!dst) return { status: 400, data: { error: '目标连接不存在' } };
      return { status: 200, data: await doStructureSync(conn, dst, data.schema, data.table, data.dstSchema, data.dstTable) };
    }
    if (p === '/api/sync-data') {
      const dst = CONNS.get(data.dstConnId);
      if (!dst) return { status: 400, data: { error: '目标连接不存在' } };
      return { status: 200, data: await doDataSync(conn, dst, data.schema, data.table, data.dstSchema, data.dstTable) };
    }
    if (p === '/api/designer-apply') return { status: 200, data: await doDesignerApply(conn, data.sql) };
    if (p === '/api/export') return { status: 200, data: await doExport(conn, data.sql, data.format || 'csv') };
    if (p === '/api/export-sql') return { status: 200, data: await doExportSql(conn, data.schema, data.table, !!data.includeData) };
    if (p === '/api/export-db') return { status: 200, data: await doExportDbSql(conn, data.db, data.mode || 'both') };
    if (p === '/api/transfer') {
      const dst = CONNS.get(data.dstConnId);
      if (!dst) return { status: 400, data: { error: '目标连接不存在' } };
      return { status: 200, data: await doTransfer(conn, dst, data.schema, data.table, data.dstTable, !!data.includeData, !!data.dropFirst, data.dstDb) };
    }
    if (p === '/api/import') return { status: 200, data: await doImport(conn, data.schema, data.table, data.csv, data.opts || {}) };
    if (p === '/api/run-sql-file') return { status: 200, data: await doRunSqlFile(conn, data.sql) };
    if (p === '/api/er') return { status: 200, data: await doEr(conn, data.schema) };
    return { status: 404, data: { error: 'unknown api: ' + p } };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/socket hang up|ECONNRESET|read ECONN|EPIPE|write after end|connection.*(lost|closed|reset)|client has gone|terminat/i.test(msg)) {
      console.error('[' + new Date().toISOString() + '] 连接失效 ' + p + ':', msg.slice(0, 200));
      return { status: 404, data: { error: '连接不存在或已断开，请重新连接' } };
    }
    if (p === '/api/execute' || p === '/api/query') {
      return { status: 400, data: { error: msg, sqlError: true } };
    }
    console.error('[' + new Date().toISOString() + '] API 错误 ' + p + ':', (e && e.stack) || e);
    return { status: 500, data: { error: msg } };
  }
}

// ---------- 补丁更新（增量热更新，无需重装安装包 / 不写 Program Files） ----------
// action:
//   check  → 对比本地 manifest 与远程 manifest，返回版本差异与变更文件清单
//   apply  → 按远程 manifest 下载变更文件到 overlay 覆盖层，写 overlay manifest
//   restart→ 仅标记（桌面端由主进程 relaunch 执行真正重启）
async function handlePatch(action, data) {
  data = data || {};
  const patchUrl = process.env.DB_NEST_PATCH_URL || (data.patchUrl || '').trim();
  if (action === 'check') {
    const localDir = UpdateUtils.resolveAppDir();
    const localManifest = UpdateUtils.readManifest(localDir) || UpdateUtils.computeManifest(localDir);
    let remote = null, remoteError = null;
    if (patchUrl) {
      try { remote = await UpdateUtils.fetchJson(patchUrl.replace(/\/$/, '') + '/manifest.json', 15000); }
      catch (e) { remoteError = String(e.message || e); }
    }
    const changes = [];
    if (remote) {
      const localFiles = localManifest.files || {};
      const remoteFiles = remote.files || {};
      for (const rel of Object.keys(remoteFiles)) {
        const lf = localFiles[rel];
        if (!lf || lf.sha256 !== remoteFiles[rel].sha256) changes.push({ path: rel, size: remoteFiles[rel].size, kind: lf ? 'update' : 'add' });
      }
      (remote.remove || []).forEach((rel) => { if (localFiles[rel]) changes.push({ path: rel, size: 0, kind: 'remove' }); });
    }
    const needUpdate = !!(remote && remote.version && remote.version !== localManifest.version && changes.length);
    return {
      status: 200,
      data: {
        localVersion: localManifest.version,
        remoteVersion: remote ? remote.version : null,
        patchUrl: patchUrl || null,
        needUpdate,
        changes,
        remoteError,
      },
    };
  }
  if (action === 'apply') {
    if (!patchUrl) return { status: 400, data: { error: '未配置补丁源（请设置 DB_NEST_PATCH_URL 或在设置中填写）' } };
    let remote;
    try { remote = await UpdateUtils.fetchJson(patchUrl.replace(/\/$/, '') + '/manifest.json', 15000); }
    catch (e) { return { status: 502, data: { error: '拉取补丁清单失败: ' + (e.message || e) } }; }
    const overlay = UpdateUtils.getOverlayDir();
    // 防止误操作覆盖整个安装目录：overlay 必须在用户可写目录内
    if (!/DBNest[\\/]app-overlay/i.test(overlay)) {
      return { status: 500, data: { error: 'overlay 路径非法，已中止以保证安全' } };
    }
    fs.mkdirSync(overlay, { recursive: true });
    let done = 0, bytes = 0;
    try {
      for (const rel of Object.keys(remote.files || {})) {
        bytes += await UpdateUtils.applyRemoteFile(patchUrl, rel, remote.files[rel].sha256, overlay);
        done++;
      }
      (remote.remove || []).forEach((rel) => { try { fs.unlinkSync(path.join(overlay, rel)); } catch (_) {} });
      // overlay 写入成功后，标记版本（下次启动 resolveAppDir 将优先使用 overlay）
      UpdateUtils.writeManifest(overlay, {
        version: remote.version,
        generatedAt: remote.generatedAt,
        files: remote.files,
        remove: remote.remove || [],
        baseVersion: (UpdateUtils.readManifest(UpdateUtils.getBaseAppDir()) || {}).version,
      });
    } catch (e) {
      return { status: 500, data: { error: '补丁应用失败: ' + (e.message || e) + '（已部分写入，重新应用可续传）' } };
    }
    return { status: 200, data: { ok: true, version: remote.version, files: done, bytes } };
  }
  if (action === 'restart') {
    return { status: 200, data: { ok: true, via: process.env.DB_NEST_IPC_ONLY ? 'ipc' : 'manual' } };
  }
  return { status: 404, data: { error: 'unknown patch action: ' + action } };
}

// 初始启动：Web 部署默认监听 0.0.0.0（局域网可直接访问）；LISTEN_HOST 可覆盖为 127.0.0.1（仅本机）；桌面 IPC 模式不启动 HTTP
httpServer = http.createServer(handleRequest);
// 桌面 IPC 模式（DB_NEST_IPC_ONLY=1）：不启动 HTTP server，纯 IPC 通道（由 Electron 主进程注册 ipcMain）
if (!process.env.DB_NEST_IPC_ONLY) {
  // Web 部署默认监听所有网卡(0.0.0.0)，局域网可直接访问；如需仅本机访问，设环境变量 LISTEN_HOST=127.0.0.1
  const initHost = process.env.LISTEN_HOST || '0.0.0.0';
  // 桌面端已由主进程 findPort 选定可用端口（PREVIEW_PORT）；纯 Node 模式用配置端口或默认 5180
  const initPort = parseInt(process.env.PREVIEW_PORT, 10) || (currentWeb.enabled ? currentWeb.port : 5180);
  currentHttpPort = initPort;
  httpServer.listen(initPort, initHost, () => {
    console.log('DBNest · 库巢 服务器已启动 → http://localhost:' + initPort + '/  （局域网访问：http://<本机IP>:' + initPort + '/）');
    console.log('（Ctrl+C 退出；连接本地 PostgreSQL 需 pg_hba 允许 127.0.0.1 的 scram-sha-256；当前已监听 0.0.0.0，同网段设备可直接访问）');
  });
}

function shutdown() {
  CONNS.forEach((c) => { try { c.end(); } catch (_) {} });
  httpServer.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
