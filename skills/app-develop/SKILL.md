---
name: app-develop
description: 在平台内开发并发布 web 应用（静态站点）。当用户要创建工具页面、数据仪表盘、监控看板、知识展示站等可在「应用」中心运行的个人应用时使用。覆盖脚手架约定、运行沙箱限制、数据 API、发布与回滚流程。
---

# 应用开发与发布

## 适用与不适用

- 适用：纯前端静态应用（HTML/CSS/JS），在平台「应用」中心以沙箱 iframe 运行。
- 不适用：需要服务端常驻进程、 WebSocket、自带数据库的应用（当前平台仅开放静态运行时；此类需求引导用户说明后另行评估）。

## 运行环境硬约束（设计时必须遵守）

1. 入口必须是产物目录根的 `index.html`；资源用相对路径引用。
2. 应用运行在不透明源沙箱内：**不可用 localStorage/cookie**（会抛异常），不可访问平台页面的 DOM 或登录态。
3. 应用身份由宿主页签发的 **app-token**（URL 参数 `?appToken=`）承载；调平台数据 API 时作 Bearer 用。
4. 平台数据 API（`/api/app-data/<appId>/<key>`）已开 CORS；调用**外部第三方 API** 要求对方支持 CORS，否则需换可 CORS 的数据源。
5. 无构建依赖优先（单文件或原生 ESM）；确需构建则产物必须落在要发布的目录（如 `dist/`），并发布该目录而非源码目录。
6. 图表用 CDN 引入 ECharts 等（`<script src="https://cdn...">`）；不要 npm 装 UI 框架除非确有构建必要。
7. 平台自动采集前端日志：应用内的 window.error、资源加载失败、console.error 会进入「应用」详情的「日志」页签（网关面同时记录页面加载与数据 API 调用）——调试时让用户看日志页签即可。

## 工作流

1. **查重**：先 `app_list`。用户要更新已有应用时记住它的 appId，直接向同一 appId 迭代发布。
2. **脚手架**：在工作区建目录（如 `my-app/`），根部放 `index.html`。最小骨架：

```html
<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>应用名</title>
  <style> body { font-family: system-ui, sans-serif; margin: 24px; } </style>
</head>
<body>
  <h1>应用名</h1>
  <div id="app">加载中…</div>
  <script type="module" src="./main.js"></script>
</body>
</html>
```

3. **接平台数据**（需要持久化/配置时），在 `main.js` 顶部解析 token 并封装：

```js
const appId = new URLSearchParams(location.search).get("appId")
  ?? location.pathname.split("/")[2]; // /apps/<appId>/
const token = new URLSearchParams(location.search).get("appToken") ?? "";
const api = (key) => `/api/app-data/${appId}/${key}`;
async function dataPut(key, value) {
  const r = await fetch(api(key), {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ value }),
  });
  if (!r.ok) throw new Error(`dataPut ${key}: HTTP ${r.status}`);
}
async function dataGet(key) {
  const r = await fetch(api(key), { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`dataGet ${key}: HTTP ${r.status}`);
  return (await r.json()).valueJson === null ? null : JSON.parse((await r.json()).valueJson);
}
```

   约束：单条 value ≤ 256KB、每应用总量 ≤ 20MB、key 仅 `[A-Za-z0-9._-]`。
4. **自检**：确认 `index.html` 在目录根部、相对路径可解析、无 localStorage/cookie 调用、无对平台登录态的假设。
5. **发布**：`app_deploy`（新应用带 `name`/`description`；已有应用带 `appId`，`dir` 指向产物目录）。发布即生效并生成新版本。
6. **交付话术**：告知用户运行路径 `/apps/<appId>/`，入口在侧边栏「应用」→ 找到应用 → 打开（运行页会签发 60 分钟令牌，过期回该页刷新）。

## 迭代与回滚

- 每次改动重新 `app_deploy` 到同一 appId = 新版本，可随时回退。
- `app_versions` 查历史；`app_publish`（appId+版本号）切回任意历史版本。
- 应用运行期写入的数据用 `app_data_list` / `app_data_get` 排查。

## 安全红线

- 不得在应用内请求平台非 `/api/app-data`、`/api/app-proxy` 的接口（app-token 无效且属越权尝试）。
- 不得把任何密钥硬编码进产物。外部服务调用走受控代理 `/api/app-proxy/<appId>/<服务名>`（POST body={path,query,body,method}，响应包装 {status,contentType,body,location?}）；用户在应用详情「通道」页把服务名绑定到 HTTP 连接器、在「凭证」页填写凭证值，平台在服务端注入鉴权——产物与代理响应永不携带凭证。前端只需约定服务名并在失败时展示 `error` 文案（503=通道未绑定/凭证未填，用户可在通道页自助解决）。
- 产物里不要包含内网地址、真实密钥、个人信息等敏感内容（应用将来可分享）。
