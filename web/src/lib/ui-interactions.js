/**
 * ui-interactions.js — 前端交互逻辑（UMD，浏览器与 Node 共用，可被 ui-interaction 测试驱动真实数据库）
 *
 * 这是"前端交互"的单一真源：连接状态、对象树构建、单元格内联编辑→生成参数化 DML、
 * 只读守卫、危险确认、查询结果窗口化等。预览页与自动化测试都调用本模块，保证
 * "被测交互逻辑 === 实际界面交互逻辑"。
 *
 * 暴露：
 *  - buildObjectTree(meta)            由真实元数据构建左侧对象树节点
 *  - canEditCell(conn, column)        只读连接 / 只读列 是否禁止编辑
 *  - generateUpdate(table, pk, pkVal, col, value)  单元格编辑→参数化 UPDATE
 *  - generateInsert(table, row)       新增行→参数化 INSERT
 *  - generateDelete(table, pk, pkVal) 删除行→参数化 DELETE
 *  - evaluateQuery(conn, sql)         执行前守卫：只读拦截 / 危险确认；返回 {action, sql, danger?}
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./db-logic.js'));
  else root.UIInteractions = factory(root.DBLogic);
})(typeof self !== 'undefined' ? self : this, function (DBLogic) {
  'use strict';

  // 由真实元数据构建对象树（分层：数据库 → 模式 → 表/视图 → 列）
  // meta: { databases: [{ name, schemas: [{ name, tables: [{name, columns:[{name,type,pk,nullable}]}], views:[{name}] }] }] }
  function buildObjectTree(meta) {
    const nodes = [];
    (meta.databases || []).forEach((db) => {
      const dbNode = { kind: 'database', name: db.name, children: [] };
      (db.schemas || []).forEach((sc) => {
        const scNode = { kind: 'schema', name: sc.name, parent: db.name, children: [] };
        (sc.tables || []).forEach((t) => {
          const tNode = {
            kind: 'table', name: t.name, schema: sc.name, database: db.name,
            columns: (t.columns || []).map((c) => ({
              kind: 'column', name: c.name, type: c.type, pk: !!c.pk, nullable: c.nullable !== false,
            })),
          };
          scNode.children.push(tNode);
        });
        (sc.views || []).forEach((v) => {
          scNode.children.push({
            kind: 'view', name: v.name, schema: sc.name, database: db.name,
            columns: (v.columns || []).map((c) => ({
              kind: 'column', name: c.name, type: c.type, pk: !!c.pk, nullable: c.nullable !== false,
            })),
          });
        });
        dbNode.children.push(scNode);
      });
      nodes.push(dbNode);
    });
    return nodes;
  }

  // 只读连接或只读列（如生成列/系统列）禁止编辑
  function canEditCell(conn, column) {
    if (conn && conn.readonly) return { ok: false, reason: '只读连接禁止编辑' };
    if (column && column.pk) return { ok: false, reason: '主键列不可直接编辑（请改整行）' };
    if (column && column.readonly) return { ok: false, reason: '该列只读' };
    return { ok: true };
  }

  // 单元格编辑 → 参数化 UPDATE（防 SQL 注入：值走参数占位符）
  function generateUpdate(table, pk, pkValue, column, value) {
    const sql = 'UPDATE ' + table + ' SET ' + column + ' = $1 WHERE ' + pk + ' = $2';
    return { sql, params: [value, pkValue] };
  }

  function generateInsert(table, row) {
    const cols = Object.keys(row).filter((k) => row[k] !== undefined);
    const colSql = cols.join(', ');
    const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
    const sql = 'INSERT INTO ' + table + ' (' + colSql + ') VALUES (' + placeholders + ')';
    return { sql, params: cols.map((k) => row[k]) };
  }

  function generateDelete(table, pk, pkValue) {
    return { sql: 'DELETE FROM ' + table + ' WHERE ' + pk + ' = $1', params: [pkValue] };
  }

  // 由筛选条件构建参数化 SELECT（Navicat 网格的"筛选/排序/分页"对应此能力）
  // opts: { columns:[..], where:[{column,op,value}], orderBy:{column,dir}, limit, offset }
  // 返回 { sql, params } —— where/limit/offset 全部参数化，值不经字符串拼接
  function buildSelect(table, opts) {
    opts = opts || {};
    const cols = opts.columns && opts.columns.length ? opts.columns.join(', ') : '*';
    let sql = 'SELECT ' + (opts.distinct ? 'DISTINCT ' : '') + cols + ' FROM ' + table;
    const params = [];
    const where = opts.where || [];
    if (where.length) {
      const parts = where.map((w) => {
        if (w.op === 'IS NULL') return w.column + ' IS NULL';
        if (w.op === 'IS NOT NULL') return w.column + ' IS NOT NULL';
        const op = (w.op || '=').toUpperCase();
        params.push(w.value);
        const ph = '$' + params.length;
        if (op === 'IN') return w.column + ' = ANY(' + ph + ')';
        if (op === 'LIKE' || op === 'ILIKE') { params[params.length - 1] = '%' + w.value + '%'; return w.column + ' ' + op + ' ' + ph; } // 包含匹配
        if (op === 'NOT LIKE' || op === 'NOT ILIKE') { params[params.length - 1] = '%' + w.value + '%'; return w.column + ' ' + op + ' ' + ph; } // 不包含
        return w.column + ' ' + (op === '!=' ? '<>' : op) + ' ' + ph;
      });
      sql += ' WHERE ' + parts.join(' ' + (opts.whereLogic === 'OR' ? 'OR' : 'AND') + ' ');
    }
    if (opts.orderBy && ((opts.orderBy.column) || (opts.orderBy.columns && opts.orderBy.columns.length))) {
      const dir = (opts.orderBy.dir || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      const cols = (opts.orderBy.columns && opts.orderBy.columns.length)
        ? opts.orderBy.columns.map((c) => opts.orderBy.raw ? c : '"' + String(c).replace(/"/g, '""') + '"').join(', ')
        : opts.orderBy.column;
      sql += ' ORDER BY ' + cols + ' ' + dir;
    }
    if (typeof opts.limit === 'number') {
      sql += ' LIMIT ' + opts.limit;
      if (typeof opts.offset === 'number') sql += ' OFFSET ' + opts.offset;
    }
    return { sql, params };
  }

  // 本地筛选（预览页在内存数据集上即时筛选，无需回服务端）
  function applyFilter(rows, filters) {
    if (!filters || !filters.length) return rows;
    return rows.filter((r) => filters.every((f) => {
      if (f.value === undefined || f.value === null || f.value === '') return true; // 空条件不约束
      const cell = r[f.column];
      const sv = String(cell == null ? '' : cell).toLowerCase();
      const fv = String(f.value).toLowerCase();
      switch ((f.op || 'LIKE').toUpperCase()) {
        case '=': return String(cell) === String(f.value);
        case '<>': case '!=': return String(cell) !== String(f.value);
        case '<': return Number(cell) < Number(f.value);
        case '<=': return Number(cell) <= Number(f.value);
        case '>': return Number(cell) > Number(f.value);
        case '>=': return Number(cell) >= Number(f.value);
        default: return sv.includes(fv); // LIKE / ILIKE
      }
    }));
  }

  // 本地排序（预览页在内存数据集上即时排序）
  function applySort(rows, column, dir) {
    if (!column) return rows;
    const desc = (dir || 'ASC').toUpperCase() === 'DESC';
    return rows.slice().sort((a, b) => {
      let av = a[column], bv = b[column];
      if (av == null && bv == null) return 0;
      if (av == null) return desc ? 1 : -1;
      if (bv == null) return desc ? -1 : 1;
      if (typeof av === 'number' && typeof bv === 'number') return desc ? bv - av : av - bv;
      const sa = String(av), sb = String(bv);
      if (sa < sb) return desc ? 1 : -1;
      if (sa > sb) return desc ? -1 : 1;
      return 0;
    });
  }

  // 执行前守卫：模拟点"运行"时的判定链路（与后端 service 同源）
  function evaluateQuery(conn, sql) {
    const cls = DBLogic.classifySql(sql);
    const danger = DBLogic.detectDangerous(sql);
    if (conn && conn.readonly && cls !== 'read') {
      return { action: 'block', reason: '只读连接拒绝执行 ' + ({ write: '写入', ddl: '结构变更' }[cls] || '非只读') + ' 语句', sql, cls, danger };
    }
    if (danger.length) {
      return { action: 'confirm', reason: '检测到危险操作，需二次确认', sql, cls, danger };
    }
    return { action: 'run', sql, cls, danger };
  }

  return {
    buildObjectTree,
    canEditCell,
    generateUpdate,
    generateInsert,
    generateDelete,
    evaluateQuery,
    buildSelect,
    applyFilter,
    applySort,
  };
});
