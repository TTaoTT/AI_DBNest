# 桌面 / Web 分离打包 · 详细技术方案与改造思路

> 版本：v2.0 · 2026-08-16
> 目标：**桌面版零端口**（纯 IPC，无 HTTP server，不暴露任何本地端口）+ **Web 版独立打包**（保留 HTTP + 0.0.0.0 局域网访问）
> 状态：**v1.0 方案已全部实施完成（2026-08-16 21:49）**
> 实施记录：①`server/preview-server.cjs` 新增 `handleApi(path,data)` 统一动作层(HTTP/IPC 共用,含错误分类 404/400/500)，HTTP 路由改为薄调用；listen 加 `DB_NEST_IPC_ONLY` 守卫 ②前端 `api()` 双通道(`window.dbAdminBridge ? IPC : fetch`)+pagehide 桌面走桥 ③`build-electron.cjs` 重写:去 findPort/server/头注入,加 `ipcMain.handle('api')` + preload(preload-dbnest.cjs, contextBridge 白名单) + `loadFile`;产物 `electron-main-ipc.cjs`(103.6KB,语法/内容校验全过) ④index.html `/preview/*` 绝对路径改相对 ⑤`build-web-dist.cjs` 产出 Web 独立包(server+server/src+web/preview+web/src+package.json+README,956KB),实测 5190 端口启动:标题/静态资源/ping 全通。桌面设置面板 IPC 模式提示 Web 开关仅 Web 版生效。

---

## 一、现状架构（改造前）

```
┌─────────────────────────────────────────────────────────┐
│  Electron 主进程 (electron-main3.cjs)                   │
│  ├─ findPort(5180起) → 绑定 127.0.0.1:PORT              │
│  ├─ 内联 preview-server.cjs 的 HTTP server（26 个 API）  │
│  ├─ webRequest 注入 X-DB-Admin-Internal 头               │
│  └─ BrowserWindow.loadURL('http://127.0.0.1:PORT/')     │
└─────────────────────────────────────────────────────────┘
                     ▲ fetch /api/*
┌────────────────────┴────────────────────────────────────┐
│  前端 web/preview/index.html（单文件 + 内联业务脚本）      │
│  api(path, body) → fetch POST /api/* → JSON             │
│  CodeMirror 5 本地 /preview/vendor/（非 CDN ✅）           │
└─────────────────────────────────────────────────────────┘
```

**关键事实（已核实）**：

| 项 | 现状 | 影响 |
|---|---|---|
| CodeMirror 5 | **本地文件** `/preview/vendor/codemirror/*.js/css`（500KB） | ✅ 无 CDN 依赖，file:// 离线可用 |
| 前端脚本引用 | 相对路径 `../src/lib/*.js` + 绝对路径 `/preview/*` | ⚠️ 绝对路径需改为相对 |
| API 层 | 26 个 `doXxx()` 独立函数 + HTTP 路由薄封装 | ✅ 可抽取复用 |
| 前端 api() | 统一 `fetch` + 断线自动重连 + keepalive | ⚠️ 需双通道改造 |
| 配置持久化 | `SETTINGS_FILE_PATH` 注入 `%APPDATA%\db-admin\db-admin.json` | ✅ 已就绪 |
| 数据库驱动 | PgWire / SqliteDriver 已内联进主进程；mysql2 走 createRequire | ✅ 桌面版已全内联 |

---

## 二、目标架构（改造后）

```
┌─ 桌面版（零端口）────────────────────────────────────────┐
│  Electron 主进程 (electron-main-ipc.cjs)                 │
│  ├─ ipcMain.handle('api', (e, {path, body}) → doXxx())  │
│  ├─ 加载 actions 层（与 Web 共用同一份业务函数）           │
│  ├─ BrowserWindow.loadFile('preview/index.html')        │
│  └─ preload.js：contextBridge.exposeInMainWorld(         │
│        'dbAdminBridge', { api: (p,b) => ipcRenderer.invoke('api',{p,b}) }) │
└─────────────────────────────────────────────────────────┘
                     ▲ window.dbAdminBridge.api()
┌────────────────────┴────────────────────────────────────┐
│  前端 api() 双通道：                                     │
│  if (window.dbAdminBridge) → bridge.api(path, body)     │
│  else → fetch（Web 版原逻辑不变）                        │
└─────────────────────────────────────────────────────────┘

┌─ Web 版（独立打包）──────────────────────────────────────┐
│  server-only/                                            │
│  ├─ server/preview-server.cjs（HTTP + actions，原样）     │
│  ├─ web/preview/*（静态资源）                            │
│  ├─ package.json（node 直接启动）                        │
│  └─ 支持 LISTEN_HOST=0.0.0.0 局域网访问                  │
└─────────────────────────────────────────────────────────┘
```

---

## 三、改造步骤（P0：桌面零端口，优先级排序）

### 步骤 1：抽 API 动作层 `server/actions.js`（工作量：小，风险：低）

**现状**：`preview-server.cjs` 里 26 个 `doXxx()` 已是从 HTTP 路由独立出来的纯函数（输入 connId + body，返回对象），路由只是 `sendJson(res, 200, await doXxx(...))` 的薄封装。

**做法**：
1. 新建 `server/actions.js`，导出 `async function handleApi(path, body) → { status, data }`
   - 内部维护 `CONNS` 连接表、`withLock`、`audit`、`settings` 等共享状态
   - 集中 `switch(path)` 分发到现有 `doXxx()`
2. `preview-server.cjs` 的 HTTP 路由改为：`const r = await handleApi(p, data); return sendJson(res, r.status||200, r.data);`
3. Electron 主进程的 IPC handler 同样调用 `handleApi(path, body)`

**收益**：业务逻辑**一份代码，双端复用**；HTTP 与 IPC 差异只剩"传输通道"，行为完全一致（含断线重连语义、锁、审计）。

**注意**：
- `CONNS` 连接表从 preview-server.cjs 移到 actions.js；HTTP 版 import 时复用
- `audit()`、`loadingStart` 等日志钩子保留在 actions 层，双端统一

### 步骤 2：前端 `api()` 双通道（工作量：小，风险：低）

**现状**（`web/preview/index.html` 第 876 行）：
```js
async function api(path, body) {
  // 循环 2 次：fetch → json → 断线自动重连 reconnOnce
}
```

**做法**：入口加桥检测：
```js
async function api(path, body) {
  if (window.dbAdminBridge) {
    // 桌面 IPC 通道（错误语义对齐 fetch：404 → {error:...}）
    let r = await window.dbAdminBridge.api(path, body);
    if (r && r.__err) { /* 重连逻辑可复用（走桥内 doReconnect） */ }
    return r;
  }
  // ...原有 fetch 逻辑不动（Web 版）
}
```

**注意**：
- 断线自动重连 `reconnOnce()` 在桌面版走桥时也要可用 → 桥暴露 `reconnect(connId)` 或复用 actions 的 connect 逻辑
- `loadingStart/loadingEnd`（顶部进度条）双通道都触发，行为一致

### 步骤 3：Electron 主进程改造（工作量：小-中，风险：中）

**改造点**（`build-electron.cjs` 模板）：
1. **去掉** `findPort` / `net.createServer` / `__START_SERVER__()` / `webRequest` 头注入
2. **新增** preload 脚本：
   ```js
   // preload.js（打包时内联）
   const { contextBridge, ipcRenderer } = require('electron');
   contextBridge.exposeInMainWorld('dbAdminBridge', {
     api: (path, body) => ipcRenderer.invoke('api', { path, body }),
     reconnect: (connId) => ipcRenderer.invoke('reconnect', connId),
   });
   ```
3. **新增** IPC handler：
   ```js
   ipcMain.handle('api', async (e, { path, body }) => {
     try {
       const r = await handleApi(path, body || {});
       return r; // { status, data }
     } catch (err) {
       return { __err: err.message }; // 对齐 HTTP 的 {error}
     }
   });
   ```
4. **窗口加载改 file://**：
   ```js
   win.loadFile(path.join(process.env.DB_ADMIN_ROOT, 'web', 'preview', 'index.html'));
   ```
5. `webPreferences`：`contextIsolation: true, nodeIntegration: false, preload: <内联到临时文件>`

**安全注意**：
- 必须保持 `contextIsolation: true` + `sandbox: true`（不因 IPC 改造放松）
- preload 只暴露 `api/reconnect` 两个白名单函数，不暴露 ipcRenderer 本体

### 步骤 4：静态资源 file:// 适配（工作量：中，风险：**最高**，需重点测试）

**已核实**：CodeMirror 本地化 ✅、无 CDN ✅。剩余问题：

| 问题 | 现状 | 方案 |
|---|---|---|
| 绝对路径 `/preview/*` | `href="/preview/vendor/..."` `src="/preview/db-logos.js"` | 改为相对 `./vendor/...` `./db-logos.js`（index.html 在 preview/ 下，天然同层） |
| `../src/lib/*.js` | 相对路径 `../src/lib/db-logic.js` | file:// 下可用 ✅（preview/ 的上级是 web/） |
| localStorage | file:// origin 下可用 | ✅ 但注意：file:// 的 origin 是 `file://` 全域共享 → **连接配置/密码与 Web 版隔离**（可接受，甚至是优点） |
| fetch 相关 | 仅 api() 用；桌面改桥后无 fetch | ✅ 无残留 |
| keepalive/pagehide 断连 | `pagehide` 时 `fetch(..., {keepalive})` 断连 | 桌面版改为桥的 `disconnectAll()`（进程退出时 OS 自动回收，可省略） |
| 字体/图标 | 内联 SVG + 系统字体 | ✅ 无外部字体 |

**结论**：资源适配主要是**把 `<script src="/preview/...">` 改为相对路径**，工作量可控。改造后必须做离线断网测试（`win.webContents.session` 断网或直接禁用网络）验证编辑器/补全/图标全可用。

### 步骤 5：Web 版独立打包（P1，工作量：小）

**做法**：新建 `deploy/web/` 目录，结构：
```
deploy/web/
├── package.json        # { "main": "preview-server.cjs", "scripts": {"start":"node ."} }
├── server/preview-server.cjs   # 原样（HTTP + actions）
└── web/preview/        # 静态资源（index.html + vendor + src 拷贝）
```
- `LISTEN_HOST` 默认 0.0.0.0、端口默认 5180（可用环境变量覆盖）
- `SETTINGS_FILE_PATH` 默认 `./db-admin.json`
- 打包脚本：`node build-web-dist.cjs`（拷贝 server + web/preview + 精简 package.json）
- 发布物：`db-admin-web.zip`（约 2MB，免 node_modules？——**需包含 mysql2 驱动**，见下）

**依赖问题**：`mysql2` 是外部依赖（PgWire/SQLite 已内联）。Web 版需：
- 方式 A：`npm install`（deploy 目录带 `package.json` 声明 `mysql2`）
- 方式 B：拷贝 `C:/Users/Darker/.dbadmin-deps/node_modules/mysql2` 进 deploy
- 推荐 A（标准做法）

---

## 四、改动清单汇总

| # | 文件 | 改动 | 工作量 |
|---|---|---|---|
| 1 | 新建 `server/actions.js` | 抽 26 个 API 分发 | 1-2h |
| 2 | `server/preview-server.cjs` | 路由改调 actions | 0.5h |
| 3 | `web/preview/index.html` | `api()` 双通道 + 绝对路径改相对 | 1h |
| 4 | `C:/Users/Darker/.dbadmin-deps/build-electron.cjs` | 去 server、加 IPC/preload/loadFile | 1-2h |
| 5 | 新建 `build-web-dist.cjs` | Web 版拷贝打包 | 0.5h |
| 6 | 测试 | 桌面离线全功能 + Web 局域网 + 断线重连 | 1-2h |

**合计：约 1 天**（含测试）。

---

## 五、风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| file:// 下绝对路径失效导致白屏 | **高** | 步骤 4 全部改相对路径；改后断网测试 |
| localStorage 在 file:// 全域共享 | 中 | 接受（桌面与 Web 配置天然隔离，实为优点）；如需严格隔离可给 file 加 `--user-data-dir` 分开 |
| IPC 与 HTTP 错误语义不一致 | 中 | actions 层统一返回 `{status,data}` / `{error}`；前端 api() 归一化 |
| 断线自动重连在桌面版失效 | 中 | 桥暴露 `reconnect()`，复用 actions.connect |
| CodeMirror 补全依赖 XHR | 低 | 补全是纯 JS 本地逻辑（已核实三层兜底），无 XHR |
| 浏览器 CSP/file:// 限制 | 低 | 无 CSP 头、无外部资源；如遇限制加 `webSecurity: false`（**不建议**，保持默认） |
| 回滚 | — | 保留 build-electron.cjs 原版 → 生成 `electron-main3.cjs` 双轨并存，一键切换 |

---

## 六、验收标准

**桌面版（零端口）**：
1. 任务管理器/`netstat` 确认**无 5180 或任何监听端口**
2. 断网（拔网线/禁用网卡）后：连接 PG/MySQL/SQLite、浏览表、编辑数据、执行 SQL、SQL 补全、导出 CSV/Excel/JSON、传输全部可用
3. 关闭窗口 → 进程完全退出，无残留 node 进程
4. 连接配置/密码保险库在 `%APPDATA%\db-admin\db-admin.json` 正常持久化

**Web 版（独立）**：
1. `node deploy/web` 启动 → `http://localhost:5180/` 可用
2. 局域网其他机器 `http://<IP>:5180/` 可访问（LISTEN_HOST=0.0.0.0）
3. 与桌面版互不影响（各自连接、各自配置）

---

## 七、可选增强（非本次范围）

- 桌面版首屏白屏兜底：`did-fail-load` 时展示错误页而非白屏
- Web 版加简单 Basic Auth（环境变量 `WEB_AUTH_USER/PASS`）
- Web 版监听端口冲突时自动 +1（复用 findPort 逻辑到 Web 版）
- 桌面版 `--port` 参数关闭 web 设置的入口（设置面板里"Web 服务开关"在桌面版隐藏）

---

## 八、实施顺序建议

```
Phase 1（P0 桌面零端口）: 步骤1 → 2 → 3 → 4 → 测试验收
Phase 2（P1 Web 独立包）: 步骤5 → 双端回归测试
Phase 3（可选增强）    : 白屏兜底 / Web Auth
```

**先行验证点（30 分钟快测）**：只改步骤 2（前端双通道 + 一个假桥）→ 把 `window.dbAdminBridge` 临时指向一个直接调用后端模块的 stub，确认 IPC 通路可行，再投入全量改造。
