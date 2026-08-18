// DBNest · 库巢 — 增量补丁生成器
//
// 作用：对比「上一版基准 app 目录」与「当前 app 目录」，产出仅含变化文件的补丁包：
//   <OUT>/manifest.json          — 远程清单（version + 每个文件 sha256/size + remove 列表）
//   <OUT>/files/<相对路径>        — 变更/新增文件（目录结构同 app）
//
// 用户侧的「检查更新」会拉取 manifest.json，与本地对比，仅下载变化文件到 overlay。
//
// 用法:
//   node build-patch.cjs --base <旧app目录> --next <新app目录> --out <补丁输出目录> [--version 1.0.1] [--remove a/b.js,c/d.css]
//
// 默认:
//   --base = 上次发布的 resources/app 快照（若没有则视为首次全量，仅用于本地验证）
//   --next = T:/AI_DataEditor 的 server+web 合并 app 目录（由本脚本即时构建）
//   --out  = C:/Users/Darker/.dbadmin-deps/dbnest-patch-out
const fs = require('fs');
const path = require('path');

const ROOT = 'T:/AI_DataEditor';
const DEFAULT_OUT = 'C:/Users/Darker/.dbadmin-deps/dbnest-patch-out';

function parseArgs(argv) {
  const a = { base: null, next: null, out: DEFAULT_OUT, version: null, remove: '' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--base') a.base = argv[++i];
    else if (k === '--next') a.next = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--version') a.version = argv[++i];
    else if (k === '--remove') a.remove = argv[++i];
  }
  return a;
}
function walk(dir, rel, out) {
  rel = rel || '';
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name.endsWith('.part')) continue;
    const full = path.join(dir, e.name);
    const r = (rel ? rel + '/' : '') + e.name;
    if (e.isDirectory()) walk(full, r, out);
    else if (e.isFile()) out.push(r);
  }
}
function sha256(p) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}
// 把 server/ + web/ 从项目根合并成一份「app 目录」(仅业务资源，不含 node_modules / electron-main.cjs)
function buildNextApp(srcRoot, dstRoot) {
  function cpDir(s, d) {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const ss = path.join(s, e.name), dd = path.join(d, e.name);
      if (e.isDirectory()) cpDir(ss, dd); else { fs.mkdirSync(path.dirname(dd), { recursive: true }); fs.copyFileSync(ss, dd); }
    }
  }
  cpDir(path.join(srcRoot, 'server'), path.join(dstRoot, 'server'));
  cpDir(path.join(srcRoot, 'web'), path.join(dstRoot, 'web'));
  const ver = args.version || '1.0.1';
  const pkg = { name: 'dbnest-app', version: ver };
  fs.writeFileSync(path.join(dstRoot, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
}

const args = parseArgs(process.argv);

// 构造「next app 目录」
const nextTmp = path.join(path.dirname(args.out), '_dbnest_next_app');
if (args.next) {
  // 用户指定了现成的 next 目录，直接用它
  // 但仍确保 package.json 存在
  if (!fs.existsSync(path.join(args.next, 'package.json'))) {
    fs.writeFileSync(path.join(args.next, 'package.json'), JSON.stringify({ name: 'dbnest-app', version: args.version || '1.0.0' }, null, 2), 'utf8');
  }
  var NEXT = args.next;
} else {
  if (fs.existsSync(nextTmp)) fs.rmSync(nextTmp, { recursive: true, force: true });
  buildNextApp(ROOT, nextTmp);
  var NEXT = nextTmp;
}

// 计算 next 的 manifest
const nextFiles = {};
const list = [];
walk(NEXT, '', list);
for (const rel of list) {
  const full = path.join(NEXT, rel);
  try { nextFiles[rel] = { sha256: sha256(full), size: fs.statSync(full).size }; } catch (_) {}
}

// 版本
let version = args.version;
if (!version) {
  try { version = JSON.parse(fs.readFileSync(path.join(NEXT, 'package.json'), 'utf8')).version; } catch (_) { version = '0.0.0'; }
}

// 与上版 base 对比，得到变更清单（用于日志；files 始终输出 next 全量 manifest，客户端按需下载差异）
let changed = [], added = [], unchanged = 0;
if (args.base && fs.existsSync(args.base)) {
  const baseFiles = {};
  const bl = [];
  walk(args.base, '', bl);
  for (const rel of bl) { try { baseFiles[rel] = sha256(path.join(args.base, rel)); } catch (_) {} }
  for (const rel of Object.keys(nextFiles)) {
    if (!baseFiles[rel]) added.push(rel);
    else if (baseFiles[rel] !== nextFiles[rel].sha256) changed.push(rel);
    else unchanged++;
  }
}

// 输出补丁包
fs.mkdirSync(args.out, { recursive: true });
const removeList = (args.remove || '').split(',').map((s) => s.trim()).filter(Boolean);
const manifest = { version, generatedAt: new Date().toISOString(), files: nextFiles, remove: removeList };
fs.writeFileSync(path.join(args.out, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

// 仅写出「变更 + 新增」文件到 files/（节省体积；客户端也会按需下载，但发布时只带差异更友好）
const filesOut = path.join(args.out, 'files');
fs.mkdirSync(filesOut, { recursive: true });
const relPaths = (args.base && fs.existsSync(args.base)) ? changed.concat(added) : Object.keys(nextFiles);
for (const rel of relPaths) {
  const src = path.join(NEXT, rel);
  const dst = path.join(filesOut, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// 清理临时
if (!args.next && fs.existsSync(nextTmp)) { try { fs.rmSync(nextTmp, { recursive: true, force: true }); } catch (_) {} }

console.log('=== DBNest 增量补丁包已生成 ===');
console.log('版本:', version);
console.log('输出目录:', args.out);
console.log('manifest 文件数:', Object.keys(nextFiles).length);
console.log('本次带入 files/ 数:', relPaths.length, (args.base ? '(差异增量)' : '(全量，因未提供 --base)'));
if (args.base) {
  console.log('  - 新增:', added.length, '· 变更:', changed.length, '· 未变:', unchanged);
}
console.log('删除列表(remove):', removeList.length ? removeList.join(', ') : '无');
console.log('部署: 将本目录挂为 HTTP 静态服务，并设置 DB_NEST_PATCH_URL=<该目录URL>/');
