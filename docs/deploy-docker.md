# donger Docker 部署运维手册

> 设计与验证记录：`docs/superpowers/specs/2026-10-10-docker-deploy-migration-design.md`（D1-D6 已拍板）
> 形态：单机 Docker Desktop（WSL2）单容器；数据 bind mount 落宿主盘；对外 3330/HTTPS/域名零变化。

## 拓扑与目录

```
栈目录 D:\deploy\donger-docker\
├─ compose.yaml   （模板来自仓库 deploy/compose.yaml）
├─ .env           （DONGER_IMAGE_TAG / DONGER_PORT / DONGER_SLOT_SUFFIX）
├─ donger.env     （容器运行时环境变量，由生产 .env 派生，含密钥，勿提交）
├─ gitconfig      （最小集：user + github 代理→host.docker.internal + safe.directory）
├─ certs\         （HTTPS 证书三件套）
├─ zcode-provider\zcode-builtin.json （zcode 内置 provider 配置，只读挂载进容器）
└─ data\          （donger.db 三件套 + workspace\，= 容器 /data，全部状态）
```

容器：`donger-app`（镜像 `donger:<tag>`，node:24-slim，USER node，PID1=node 直收 SIGTERM）。
镜像内置：`/app`（dist+node_modules+skills 内置技能）、`/opt/zcode-cli`（zcode CLI 纯 JS）、
ENV `SHELL=/bin/bash TZ=Asia/Shanghai DONGER_ZCODE_CLI_PATH=/opt/zcode-cli/zcode.cjs BUILTIN_SKILLS_DIR=/app/skills`。

## 首次构建（D5：本机手动）

```bash
cd /d/code/donger
powershell… 或手动备料（deploy/stage.ps1 在部分环境会段错误，可直接 robocopy）：
  robocopy "C:\Program Files\ZCode\resources\glm" "D:\code\donger\deploy\assets\zcode-cli" /MIR /NFL /NDL /NJH /NJS
  robocopy "D:\deploy\donger\.superpowers" "D:\code\donger\deploy\assets\superpowers" /MIR /NFL /NDL /NJH /NJS
docker build -f deploy/Dockerfile -t donger:$(date +%Y%m%d-%H%M) .
```

Git Bash 下调用 docker 的铁律：容器内绝对路径参数会被 MSYS 改写（`/x` → `C:/Program Files/Git/x`），
脚本已内置 `export MSYS_NO_PATHCONV=1`；手敲命令需要时加前缀 `MSYS_NO_PATHCONV=1`。

## 迁移/切换

```bash
# 演练（不停生产，端口 3331，栈目录 D:\deploy\donger-rehearsal，自动解除武装：停工作流+作废在途通知）
scripts/docker-migrate.sh --rehearse --image donger:<tag>
# 真切换（先停 3330 旧 runner 进程，栈目录 D:\deploy\donger-docker）
scripts/docker-migrate.sh --execute --image donger:<tag>
```

脚本内含：staging 拷贝（DB 三件套+workspace，robocopy /R:1 /W:1）→ 清 donger.lock →
`rewrite-db-paths.cjs` 事务改写 `users.data.homeDir`（三形态→`/data/workspace/users/<id>`，断言零残留+integrity ok）→
装配 certs/provider/env/gitconfig/compose → `compose up` → 健康等待。
回滚：`cd <栈目录> && docker compose down` + 旧 `runner.ps1` 重启（旧目录全程未动，迁移写的是拷贝）。

## 升级 / 回滚（日常）

```bash
cd /d/code/donger && git pull
<备料若 zcode CLI 有更新>
docker build -f deploy/Dockerfile -t donger:20261101-1000 .
# 切镜像：改 D:\deploy\donger-docker\.env 的 DONGER_IMAGE_TAG=20261101-1000
cd /d/deploy/donger-docker && docker compose up -d
# 回滚 = .env 改回旧 tag + up -d（旧镜像保留在本机）
```

停机=容器重启（秒级，`stop_grace_period: 120s`）；启动迁移自动跑；restart-sweep 兜底在途任务。

## 备份 / 还原（D4）

```bash
scripts/docker-backup.sh                 # → D:\deploy\backups\<ts>\{donger.db, workspace.tgz}，保留 14 份
```

例行化（管理员 PowerShell 一次）：
```powershell
schtasks /create /tn "donger-docker-backup" /tr "C:\Program Files\Git\bin\bash.exe -c 'cd /d/code/donger && scripts/docker-backup.sh'" /sc daily /st 03:30
```
还原：解 workspace.tgz 覆盖 `data\workspace\`，用 donger.db 覆盖三件套（先 `docker compose down`），再 `up -d`。
纪律：容器运行期间禁止在宿主侧直接写 `data\donger.db`（备份走脚本容器内 `.backup()`）。

## 日常运维

```bash
docker logs -f donger-app                 # 应用日志（stdout，json-file 轮转 50m×5）
docker logs donger-app 2>&1 | grep -i error
docker restart donger-app                 # 重启（restart-sweep 会兜底标记在途任务）
docker compose -f /d/deploy/donger-docker/compose.yaml ps
docker exec -it donger-app bash           # 进容器（读边界/confine 语义同线上）
```

host_exec 白名单语义：agent 的「本机」= 容器文件系统；查宿主侧日志用 `docker logs`。

## 已知行为 delta 与限制

- **VPN 内网主机不可达（homedb 事件 2026-10-11）**：Docker Desktop(WSL2) 的 NAT 出站不走 OpenVPN 隧道路由——容器内到 VPN 后面网段（如 192.168.1.x）TCP 全超时，宿主直发正常。现用宿主 portproxy 解决：
  `netsh interface portproxy` `10.9.101.78:2222 → 192.168.1.103:22`（重启持久）；`ssh-homedb` 凭证值已改 host=10.9.101.78/port=2222。
  维护口径：目标机换 IP/换端口 → 改 portproxy（管理员）+ 凭证页改 host/port 两处；宿主 LAN IP 变化（DHCP）→ 同步改这两处。新增 VPN 内网目标 → 照此模式加新 portproxy。
- **内置技能首次真实生效**（D6）：`BUILTIN_SKILLS_DIR=/app/skills`，仓库 7 技能可见（生产裸机时代该目录解析到不存在的 `data/repos/skills`）。不想要则把 donger.env 里 BUILTIN_SKILLS_DIR 指向空目录。
- zcode 桌面插件（computer-use/browser-use 等）内含 win32 原生依赖（sharp/koffi），容器内对应 plugin 能力降级；核心对话/MCP/技能不受影响（app-server 启动+会话迁移实证通过）。
- zcode CLI 更新随 ZCode 桌面端：重跑备料 + 重建镜像。
- 容器内 github 访问走 `host.docker.internal:7897` 代理——需宿主 Clash 开 Allow LAN，否则容器内 github 失联（gitee/jihulab 不受影响）。
- Docker Desktop 需开机自启 + Windows 自动登录（`restart: unless-stopped` 只管引擎活着时）。

## 回退口径（D1 风险兜底）

若 bind mount 上出现 SQLite 异常（IOErr/损坏）：compose.yaml 增加 `donger-db:/db` named volume 并把
`DB_PATH=/db/donger.db`（workspace 保持 bind mount），一次性把 `data\donger.db*` 拷入卷即可，无需重做迁移。
M0 压测基线：9p 上 14,327 rows/s、busy=0、kill -9 崩溃恢复 integrity ok——正常运维无需回退。
