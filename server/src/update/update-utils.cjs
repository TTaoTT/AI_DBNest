'use strict';
/**
 * update-utils.cjs — DBNest 补丁更新核心工具
 *
 * 设计目标：让"业务资源（server/ + web/ + 前端逻辑）"可增量热更新，
 * 而不必重新下载 200MB 的 Electron 运行时安装包，也无需写入受保护的
 * Program Files（不需要管理员权限）。
 *
 * 解析规则（resolveAppDir）：
 *   - 若用户可写 overlay 目录(%APPDATA%/DBNest/app-overlay)已存在业务资源，则优先使用；
 *   - 否则回退到安装基准目录(resources/app)。
 * 应用启动时主进程据此选择加载哪一份 server/web。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { get } = require('https');
const { get: httpGet } = require('http');

// 安装基准 app 目录：server/src/update/update-utils.cjs → ../../../.. = resources/app
function getBaseAppDir() {
  return path.resolve(__dirname, '..', '..', '..');
}
function getOverlayDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return process.env.DB_NEST_OVERLAY_DIR || path.join(base, 'DBNest', 'app-overlay');
}
// 业务资源目录：overlay 优先（用户可写，可热补丁），回退安装基准
function resolveAppDir() {
  const ov = getOverlayDir();
  if (fs.existsSync(path.join(ov, 'server', 'preview-server.cjs'))) return ov;
  return getBaseAppDir();
}

const MANIFEST_NAME = '.dbnest-manifest.json';

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

// 递归枚举 dir 下需要纳入补丁的文件（排除 node_modules / 隐藏文件 / .part 临时文件）
function walkFiles(dir, rel, out) {
  rel = rel || '';
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === MANIFEST_NAME || e.name.startsWith('.') || e.name.endsWith('.part')) continue;
    const full = path.join(dir, e.name);
    const r = (rel ? rel + '/' : '') + e.name;
    try {
      if (e.isDirectory()) walkFiles(full, r, out);
      else if (e.isFile()) out.push(r);
    } catch (_) {}
  }
}

// 计算 dir 的 manifest（每个相对路径的 sha256 + size + 版本）
function computeManifest(dir) {
  const files = {};
  const list = [];
  walkFiles(dir, '', list);
  for (const rel of list) {
    const full = path.join(dir, rel);
    try {
      const st = fs.statSync(full);
      files[rel] = { sha256: sha256File(full), size: st.size };
    } catch (_) {}
  }
  let ver = '0.0.0';
  try { ver = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || ver; } catch (_) {}
  return { version: ver, generatedAt: new Date().toISOString(), files };
}

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), 'utf8')); } catch (_) { return null; }
}
function writeManifest(dir, m) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(m, null, 2), 'utf8');
}

// HTTP(S) GET 文本内容（带重定向跟随、超时）
function fetchText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? get : httpGet;
    const req = lib(url, { timeout: timeoutMs || 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchText(res.headers.location, timeoutMs));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时 ' + url)); });
  });
}
async function fetchJson(url, timeoutMs) {
  return JSON.parse(await fetchText(url, timeoutMs));
}

// 下载单个文件到 dest（带 .part 临时 + 原子改名）
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? get : httpGet;
    const req = lib(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + '.part';
      const ws = fs.createWriteStream(tmp);
      res.pipe(ws);
      ws.on('finish', () => { try { fs.renameSync(tmp, dest); resolve(); } catch (e) { reject(e); } });
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('下载超时 ' + url)); });
  });
}

// 把单个远程文件写入 overlay（按 rel 路径），并校验 sha256
async function applyRemoteFile(patchBaseUrl, rel, expectSha, overlayDir) {
  const url = patchBaseUrl.replace(/\/$/, '') + '/files/' + rel;
  const dest = path.join(overlayDir, rel);
  await downloadFile(url, dest);
  if (expectSha) {
    const got = sha256File(dest);
    if (got !== expectSha) { try { fs.unlinkSync(dest); } catch (_) {} throw new Error('校验失败: ' + rel); }
  }
  return fs.statSync(dest).size;
}

module.exports = {
  getBaseAppDir, getOverlayDir, resolveAppDir,
  computeManifest, readManifest, writeManifest,
  fetchJson, applyRemoteFile, MANIFEST_NAME,
};
