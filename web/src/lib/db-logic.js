/**
 * db-logic.js — 前端核心纯逻辑（UMD，前后端共用单一真源）
 *
 * 设计原则：
 *  - 零依赖，既能被 Node `require` 跑测试，也能被浏览器 `<script>` 加载（挂到 window.DBLogic）。
 *  - 与后端 dialects/types.ts、vault/connection 的判定保持语义一致，作为前端侧的镜像。
 *
 * 暴露能力：
 *  - classifySql(sql)              语句分类：read | write | ddl | other
 *  - isReadOnlyStatement(sql)      是否只读（用于只读连接的写/DDL 守卫）
 *  - detectDangerous(sql)          危险语句检测（DROP/TRUNCATE/无 WHERE 的 DELETE/UPDATE 等）
 *  - validateConnection(cfg)       连接配置校验，返回 {valid, errors, warnings}
 *  - computeVirtualRange(...)      虚拟表格窗口计算（开始/结束索引、偏移、总高）
 *  - formatCell(value)             单元格显示格式化（NULL/Date/对象）
 *  - knownDialects                 支持的方言清单
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.DBLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KNOWN_DIALECTS = [
    'mysql',
    'mariadb',
    'tidb',
    'oceanbase',
    'postgresql',
    'openGauss',
    'sqlite',
    'oracle',
    'mssql',
    'mongo',
  ];

  const DEFAULT_PORTS = {
    mysql: 3306,
    mariadb: 3306,
    tidb: 4000,
    oceanbase: 2881,
    postgresql: 5432,
    openGauss: 5432,
    sqlite: 0,
    oracle: 1521,
    mssql: 1433,
    mongo: 27017,
  };

  function stripComments(sql) {
    if (typeof sql !== 'string') return '';
    return sql
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ')
      .replace(/#[^\n]*/g, ' ')
      .replace(/--.*$/gm, ' ');
  }

  function firstKeyword(sql) {
    const s = stripComments(sql).trim();
    if (!s) return '';
    const m = s.match(/^[A-Za-z]+/);
    return m ? m[0].toUpperCase() : '';
  }

  // 取第一个实质动词（处理 WITH 起头的 CTE，通常仍是查询）
  function headVerb(sql) {
    const kw = firstKeyword(sql);
    if (kw === 'WITH') {
      // CTE：找第一个非 WITH 的关键动词
      const s = stripComments(sql).toUpperCase();
      const m = s.match(/\b(SELECT|INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|MERGE|GRANT|REVOKE)\b/);
      return m ? m[1] : 'SELECT';
    }
    return kw;
  }

  /**
   * 语句分类。
   * read: 查询类（SELECT/WITH...SELECT/SHOW/PRAGMA/EXPLAIN/DESCRIBE）
   * write: 数据变更（INSERT/UPDATE/DELETE/REPLACE/MERGE/UPSERT/SET/CALL）
   * ddl:  结构变更（CREATE/DROP/ALTER/TRUNCATE/RENAME/GRANT/REVOKE/COMMENT/BEGIN/COMMIT/ROLLBACK）
   * other: 无法判定
   */
  function classifySql(sql) {
    const verb = headVerb(sql);
    switch (verb) {
      case 'SELECT':
      case 'SHOW':
      case 'PRAGMA':
      case 'EXPLAIN':
      case 'DESCRIBE':
      case 'DESC':
        return 'read';
      case 'INSERT':
      case 'UPDATE':
      case 'DELETE':
      case 'REPLACE':
      case 'MERGE':
      case 'UPSERT':
      case 'SET':
      case 'CALL':
        return 'write';
      case 'CREATE':
      case 'DROP':
      case 'ALTER':
      case 'TRUNCATE':
      case 'RENAME':
      case 'GRANT':
      case 'REVOKE':
      case 'COMMENT':
      case 'BEGIN':
      case 'COMMIT':
      case 'ROLLBACK':
        return 'ddl';
      default:
        return 'other';
    }
  }

  function isReadOnlyStatement(sql) {
    return classifySql(sql) === 'read';
  }

  // 是否有 WHERE 子句（粗略判定，用于危险确认）
  function hasWhere(sql) {
    return /\bwhere\b/i.test(stripComments(sql));
  }

  /**
   * 危险语句检测，返回 [{type, reason}]。
   * 用于执行写/DDL 前向用户二次确认。
   */
  function detectDangerous(sql) {
    const out = [];
    const verb = headVerb(sql);
    if (verb === 'DROP') out.push({ type: 'DROP', reason: '将删除数据库对象，操作不可逆' });
    if (verb === 'TRUNCATE') out.push({ type: 'TRUNCATE', reason: '将清空整张表，操作不可逆' });
    if (verb === 'DELETE' && !hasWhere(sql)) out.push({ type: 'DELETE_NO_WHERE', reason: '无 WHERE 条件，将删除全表数据' });
    if (verb === 'UPDATE' && !hasWhere(sql)) out.push({ type: 'UPDATE_NO_WHERE', reason: '无 WHERE 条件，将更新全表数据' });
    if (verb === 'GRANT' || verb === 'REVOKE') out.push({ type: 'PRIVILEGE', reason: '涉及权限变更' });
    return out;
  }

  /**
   * 连接配置校验。
   * cfg: { type, host, port, database, username, password, filePath, readonly }
   */
  function validateConnection(cfg) {
    const errors = [];
    const warnings = [];
    cfg = cfg || {};
    if (!KNOWN_DIALECTS.includes(cfg.type)) {
      errors.push('不支持的数据库类型：' + (cfg.type || '(空)'));
      return { valid: false, errors, warnings };
    }
    if (cfg.type === 'sqlite') {
      if (!cfg.filePath || !String(cfg.filePath).trim()) {
        errors.push('SQLite 需要指定数据库文件路径');
      }
    } else {
      if (!cfg.host || !String(cfg.host).trim()) errors.push('主机地址不能为空');
      const port = cfg.port === '' || cfg.port == null ? DEFAULT_PORTS[cfg.type] : Number(cfg.port);
      if (!(Number.isInteger(port) && port >= 1 && port <= 65535)) {
        errors.push('端口必须为 1-65535 之间的整数');
      }
      if (!cfg.username || !String(cfg.username).trim()) {
        warnings.push('未填写用户名，部分数据库可能拒绝匿名连接');
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  function defaultPort(type) {
    return DEFAULT_PORTS[type] != null ? DEFAULT_PORTS[type] : 0;
  }

  /**
   * 虚拟表格窗口计算。
   * @param scrollTop 当前滚动像素
   * @param rowHeight 行高
   * @param viewportHeight 视口高度
   * @param totalRows 总行数
   * @param overscan 上下额外渲染行数（默认 6）
   * @returns { startIndex, endIndex, offsetY, totalHeight, visibleCount }
   */
  function computeVirtualRange(scrollTop, rowHeight, viewportHeight, totalRows, overscan) {
    rowHeight = Math.max(1, rowHeight || 28);
    viewportHeight = Math.max(0, viewportHeight || 0);
    totalRows = Math.max(0, totalRows | 0);
    overscan = overscan == null ? 6 : overscan;
    const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
    let startIndex = Math.floor(scrollTop / rowHeight) - overscan;
    startIndex = Math.max(0, Math.min(startIndex, Math.max(0, totalRows - visibleCount)));
    const endIndex = Math.min(totalRows, startIndex + visibleCount + overscan * 2);
    return {
      startIndex,
      endIndex,
      offsetY: startIndex * rowHeight,
      totalHeight: totalRows * rowHeight,
      visibleCount,
    };
  }

  /**
   * 单元格显示格式化。返回 { text, isNull }。
   */
  function formatCell(value) {
    if (value === null || value === undefined) return { text: 'NULL', isNull: true };
    if (value instanceof Date) return { text: value.toISOString(), isNull: false };
    if (typeof value === 'object') {
      try {
        return { text: JSON.stringify(value), isNull: false };
      } catch (e) {
        return { text: String(value), isNull: false };
      }
    }
    return { text: String(value), isNull: false };
  }

  return {
    KNOWN_DIALECTS,
    DEFAULT_PORTS,
    classifySql,
    isReadOnlyStatement,
    detectDangerous,
    hasWhere,
    validateConnection,
    defaultPort,
    computeVirtualRange,
    formatCell,
  };
});
