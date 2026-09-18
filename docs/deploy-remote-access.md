# donger 远程部署与访问指南

本文档说明如何把 donger 部署到任意机器，并通过 **DDNS + 端口转发** 以 HTTP 形式远程访问。

## 1. 前置条件

- 目标机器：Node.js ≥ 20、git
- 一条公网可达入口：DDNS 域名 + 路由器端口转发（或云主机公网 IP）
- 钉钉企业自建应用（如需钉钉登录/通道）：开发者后台可配置回调白名单

## 2. 部署流程（目标机重新构建）

> 必须在**目标机**上构建，而非把别处的 `.deploy/` 直接拷过来——`better-sqlite3` 是原生模块，其预编译二进制绑定 OS / CPU 架构 / Node 大版本，跨机拷贝会启动失败。目标机执行 `npm install` 会为本机重编译，天然适配任意环境。

```bash
# 1. 拉取代码
git clone <仓库地址> donger && cd donger
git checkout <目标分支或 master>

# 2. 准备开发用 .env（部署脚本会从中继承 LLM/钉钉/JWT 等关键配置）
cp .env.example .env
#   编辑 .env 填入：ANTHROPIC_AUTH_TOKEN、DINGTALK_*、JWT_SECRET 等

# 3. 一键部署（构建前后端 + 生成 .deploy/.env）
bash scripts/deploy.sh --port 3300

# 4. 启动（cwd 必须在 .deploy/，相对路径才能正确解析）
cd .deploy && npm start
```

启动后控制台会打印监听地址 `0.0.0.0:3300`。

## 3. 远程访问（DDNS + 端口转发）

服务默认监听 `HOST=0.0.0.0`（已在生成的 `.deploy/.env` 中显式写入），即本机所有网卡。要让它从公网可达：

1. **DDNS**：在路由器或 DDNS 客户端把一个域名动态解析到出口公网 IP（例：`donger.example.ddns.net`）。
2. **端口转发**：在路由器把 `公网端口`（如 `3300`）转发到内网 `目标机IP:3300`。
3. **访问**：浏览器打开 `http://donger.example.ddns.net:3300`。

> 若公网端口被运营商封禁，可在路由器把外部任意端口（如 `8080`）转发到内网 `3300`，访问时带外部端口。

监听端口由 `PORT` 控制，监听地址由 `HOST` 控制，二者均可改 `.deploy/.env` 后重启。

## 4. 钉钉登录回调白名单

钉钉 OAuth 回调地址由后端从请求 `Host` 头动态拼接（路径固定为 `/api/auth/dingtalk/callback`），因此**无需改代码**，只需在钉钉开发者后台登记实际访问地址：

- 登录 [钉钉开发者后台](https://open-dev.dingtalk.com/) → 你的应用 → 登录/回调配置
- 回调地址填：`http://<你的域名>:<公网端口>/api/auth/dingtalk/callback`
- 例：`http://donger.example.ddns.net:3300/api/auth/dingtalk/callback`

## 5. better-sqlite3 跨机排错

若启动时报 `Could not locate the bindings file` 或原生模块加载失败（通常是拷贝产物跨机导致），在 `.deploy/` 下重编译：

```bash
cd .deploy && npm rebuild better-sqlite3
```

或直接按第 2 节流程在目标机重新跑 `deploy.sh`。

## 6. 安全提示（HTTP 明文）

本方案为 HTTP 直连，流量未加密。缓解措施：

- 服务已有 **JWT 鉴权**，高危操作（部署/发布/推送）有**审批门**。
- 使用**专用账号**，不要在公网暴露管理面给无关人员。
- `JWT_SECRET` 通过安全渠道传递，不要提交进仓库。
- 如需加密，可在前置网关或云厂商处启用 TLS（超出本方案范围）。

## 7. 可选：进程守护

`npm start` 为前台进程，重启不会自动拉起。按需选用：

**systemd**（Linux）：

```ini
# /etc/systemd/system/donger.service
[Unit]
Description=donger
After=network.target

[Service]
WorkingDirectory=/opt/donger/.deploy
ExecStart=/usr/bin/node /opt/donger/.deploy/dist/index.js
Restart=on-failure
User=donger

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now donger
```

**pm2**：

```bash
npm i -g pm2
cd .deploy && pm2 start dist/index.js --name donger
pm2 save && pm2 startup
```
