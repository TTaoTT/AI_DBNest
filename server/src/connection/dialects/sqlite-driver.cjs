'use strict';
// 零依赖 SQLite 驱动：基于 Node 22 内置 node:sqlite（实验性但稳定可用）
// 统一接口：{ type, database, connect(), query(sql), queryParams(sql,params), end() }
const fs = require('fs');
const path = require('path');
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) {}

class SqliteDriver {
  constructor(cfg) {
    this.type = 'sqlite';
    this.cfg = cfg || {};
    this.file = String(cfg.file || cfg.database || 'local.db');
    if (!this.file.startsWith(':') && !path.isAbsolute(this.file)) this.file = path.resolve(process.cwd(), this.file);
    this.database = this.file;
    this.db = null;
    this.err = null;
  }
  async connect() {
    if (!DatabaseSync) throw new Error('当前 Node 版本不支持 node:sqlite');
    if (!this.file.startsWith(':')) {
      if (!fs.existsSync(this.file)) {
        // 允许自动建库（与 Navicat 一致：选择路径即可打开/新建）
        const dir = path.dirname(this.file);
        if (dir && !fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} }
      }
    }
    try {
      this.db = new DatabaseSync(this.file);
    } catch (e) {
      throw new Error('打开 SQLite 失败：' + e.message);
    }
    return { user: 'sqlite', database: this.file };
  }
  // 占位符 $1/$2 → ?（SQLite 用 ?）
  _conv(sql) { return String(sql).replace(/\$(\d+)/g, '?'); }
  async query(sql) { return this._run(sql, []); }
  async queryParams(sql, params) { return this._run(sql, params || []); }
  _run(sql, params) {
    if (!this.db) throw new Error('SQLite 未连接');
    const conv = this._conv(sql);
    const st = this.db.prepare(conv);
    const isRead = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/i.test(conv.trim());
    if (isRead) {
      const rows = st.all(...params);
      const fields = rows && rows.length ? Object.keys(rows[0]).map((n) => ({ name: n, type: '' })) : [];
      return { fields, rows: rows || [], rowCount: rows ? rows.length : 0, command: 'SELECT' };
    }
    const r = st.run(...params);
    return { fields: [], rows: [], rowCount: r.changes || 0, command: 'OK', lastInsertRowid: r.lastInsertRowid };
  }
  end() { try { if (this.db) { this.db.close(); this.db = null; } } catch (_) {} }
}
module.exports = { SqliteDriver };
