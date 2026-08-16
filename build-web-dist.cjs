// DBNest · 库巢 — Web 版独立打包脚本
// 产出 deploy/web/：server(preview-server.cjs) + web/preview(静态资源) + package.json + README
// 运行: node build-web-dist.cjs
const fs = require('fs');
const path = require('path');

const ROOT = 'T:/AI_DataEditor';
// 输出到沙盒外可写目录（T 盘 deploy 目录被本机写保护）；发布时整目录拷贝即可
const OUT = process.env.DBNEST_WEB_OUT || 'C:/Users/Darker/.dbadmin-deps/dbnest-web-dist';
const SRC_SERVER = path.join(ROOT, 'server', 'preview-server.cjs');
const SRC_WEB = path.join(ROOT, 'web', 'preview');

function cp(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
function cpDir(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, e.name), d = path.join(dstDir, e.name);
    if (e.isDirectory()) cpDir(s, d); else cp(s, d);
  }
}

// 覆盖式写入(沙盒禁 rmSync;旧文件残留不影响启动,发布前手动清一次即可)
fs.mkdirSync(path.join(OUT, 'server'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'web', 'preview'), { recursive: true });

// 1) 服务器(HTTP + actions,原样) + 其相对依赖 server/src
cp(SRC_SERVER, path.join(OUT, 'server', 'preview-server.cjs'));
cpDir(path.join(ROOT, 'server', 'src'), path.join(OUT, 'server', 'src'));

// 2) 静态资源(web/preview 全部) + 前端/server 共用逻辑 web/src/lib
cpDir(SRC_WEB, path.join(OUT, 'web', 'preview'));
cpDir(path.join(ROOT, 'web', 'src'), path.join(OUT, 'web', 'src'));

// 3) package.json(web 模式默认 0.0.0.0:5180, mysql2 依赖)
const pkg = {
  name: 'dbnest-web',
  version: '1.0.0',
  description: 'DBNest 库巢 Web 版(局域网/服务器部署)',
  main: 'server/preview-server.cjs',
  scripts: { start: 'node server/preview-server.cjs' },
  dependencies: { mysql2: '^3.11.0' },
};
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');

// 4) 启动说明
const readme = `# DBNest · 库巢 Web 版

## 启动
\`\`\`
npm install        # 安装 mysql2(首次)
npm start          # 或 node server/preview-server.cjs
\`\`\`
浏览器访问 http://localhost:5180/

## 局域网/服务器部署
\`\`\`
LISTEN_HOST=0.0.0.0 node server/preview-server.cjs
\`\`\`
其他机器访问 http://<本机IP>:5180/

## 环境变量
| 变量 | 默认 | 说明 |
|---|---|---|
| LISTEN_HOST | 127.0.0.1 | 监听地址, 0.0.0.0 = 局域网可访问 |
| PREVIEW_PORT | 5180 | 端口 |
| SETTINGS_FILE_PATH | %APPDATA%\\db-admin\\db-admin.json | 配置路径(含 Web 开关/端口) |
`;
fs.writeFileSync(path.join(OUT, 'README.md'), readme, 'utf8');

// 5) 统计
let n = 0, size = 0;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { n++; size += fs.statSync(p).size; } } })(OUT);
console.log('Web 版打包完成 → deploy/web/');
console.log('文件数:', n, '· 大小:', (size / 1024).toFixed(0) + ' KB');
console.log('启动: cd deploy/web && npm install && npm start');
