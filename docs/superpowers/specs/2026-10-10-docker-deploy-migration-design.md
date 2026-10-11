# donger Docker 化部署迁移设计

- 日期：2026-10-10 设计 / 2026-10-11 拍板并实施
- 状态：**已拍板（D1-D6 全部裁决，见 §7），M1 资产已落地，M0 验证与 M2 演练随行记录（§8）**
- 前置摸底：本机 Docker Desktop 4.85（WSL2 backend，engine linux/amd64）；生产裸机部署 `D:\deploy\donger`（HTTPS 3330，node v24.20）；仓库容器化资产原仅有 `docs/deploy-k8s-jenkins.md` 内的提案级 Dockerfile，本设计将其实体化为 `deploy/`。

## 0. 结论摘要

1. **目标形态**：单机 Docker Desktop 跑**单容器**（compose 编排），**数据 bind mount 落宿主 D 盘**（D1 拍板），对外端口 3330 / HTTPS / DDNS 域名 / 钉钉与 GitHub 回调**零变化**。不引入 K8s/云端，也不拆数据库容器（SQLite 内嵌不变）。
2. **代码改动 ≈ 0**：路径抽象早已收口为三个 env（`DB_PATH`/`WORKSPACE_DIR`/`BUILTIN_SKILLS_DIR`，`src/config.ts:218-226`）；zcode CLI 有 `DONGER_ZCODE_CLI_PATH` 逃生门；Claude CLI 的 `SHELL=/bin/bash` 坑、better-sqlite3 预编译、COPY 顺序坑均有 K8s 轮实证文档背书。唯一可选一行改动=默认提示词里 Windows /tmp 文案（`src/index.ts:319-322`）。
3. **数据迁移的真正难点只有一个**：`users.data(JSON).homeDir` 里的历史绝对路径。实测 7 个用户中 6 个仍写着 09-30 迁移前的旧目录 `D:\code\donger\.deploy\donger\...`，目前靠运行时"悬空重推导"兜底在活数据上工作（旧树 10 月后 0 个新文件、新树 1937 个）。迁移脚本按映射表统一改写为 `/data/workspace/users/<id>`，**顺带消除这颗历史地雷**。
4. **zcode 引擎容器化预判可行**：CLI 为纯 JS（`zcode.cjs + packages/`，核心无原生二进制；plugin 包内 sharp/koffi 为 win32 变体，容器内对应 plugin 能力降级），M0 spike 实证（D2）。
5. 镜像基线 **node:24-slim**（对齐生产宿主 v24.20，推翻 K8s 文档的 node:20），复用官方内置 uid 1000 `node` 用户。

## 1. 背景与目标

- 现状：`runner.ps1` 就地重建+重启（先杀端口占进程再拉起，存在宕机窗口），生产树含 src/web/node_modules 全量，升级=git archive 覆盖。
- 目标：镜像不可变部署；升级/回滚=换镜像 tag + `up -d`（秒级）；依赖与工具链版本锁定在镜像内；消除"先停后建"窗口面。
- 非目标：云端/K8s（维持 DDNS+单机）、多副本、换数据库、功能变更。

## 2. 摸底事实底座（设计依据）

### 2.1 配置与路径

| 事实 | 锚点 |
|---|---|
| 数据根=三 env：`DB_PATH`/`WORKSPACE_DIR`/`BUILTIN_SKILLS_DIR`，相对路径按进程 cwd resolve | `src/config.ts:218-226` |
| 生产 .env 全部为相对路径（`./data/workspace`、`.certs/cert.pem`），cwd 锚定 | `D:\deploy\donger\.env` |
| DB 内持久化绝对路径**仅** `users.data.homeDir` 一类；`skill_packs.installedPath` 实测 3 行全相对（`.skills/<slug>`）；转录在 SQLite 表内；`.zcode-home`/`.codex-home`/记忆/KB/附件全部锚在 homeDir 或 workspaceDir 下 | `src/adapters/sqlite-user-store.ts:126`；探针实测 |
| `REPO_ROOT`/`MEMORY_DIR` 无消费方（遗留键）；生产 `data/` 活跃状态= `donger.db{,-wal,-shm}` + `workspace/{users,feedback,kb}` | `src/config.ts` 全文 grep；目录实测 |
| `SUPERPOWERS_PLUGIN_PATH` 生产为空未启用；prod 根 `.superpowers/sdd` 为遗留目录（镜像照抄保平价） | 生产 .env 实测 |
| **意外发现①**：6/7 用户 homeDir 指向 09-30 前旧目录，运行时悬空兜底撑着；活数据在新目录 | 探针+文件时间戳实测 |
| **意外发现②**：生产 `builtinSkillsDir` 解析到不存在的 `data/repos/skills`（`REPO_ROOT=./data/repos` 遗留值所致）；仓库自带 `skills/` 7 个内置技能在生产实际不可见 | `config.ts:226`+目录实测 |

### 2.2 引擎运行面

| 引擎 | 容器内要点 | 锚点 |
|---|---|---|
| claude SDK | 自 spawn CLI；Linux 必须 `SHELL=/bin/bash`（缺失报 No suitable shell found，9-22 实证坑）；无 Git Bash 的 PowerShell 回退不触发 | `deploy-k8s-jenkins.md:96-107` |
| codex SDK | 按平台 optional deps 取二进制，linux-x64 随 `npm ci` 自动安装；Windows 沙箱降级逻辑在 Linux 不触发，`DONGER_CODEX_SANDBOX_MODE` 逃生门保持不动 | `src/adapters/codex-agent-runner.ts:76-134` |
| zcode | spawn `node <cli>/zcode.cjs app-server`（stdio NDJSON，握手=`session/create`）；CLI 纯 JS（glm 目录实测无凭证文件，可安全 COPY 进镜像）；`DONGER_ZCODE_CLI_PATH` 指容器内路径，零代码改动 | `src/adapters/zcode-agent-runner.ts:362,792-834` |
| git | spawn git 参数数组；win32 分支（longpaths/askpass.cmd）Linux 走 posix 分支（CI ubuntu 已背书）；**刻意保留宿主全局 gitconfig**——容器内需自行提供，且 github 代理 `127.0.0.1:7897` 须翻译为 `host.docker.internal:7897`（宿主代理须开 Allow LAN 才可达，切窗口验证） | `src/util/git-process.ts:13-14,68,131-149` |

### 2.3 守卫与生命周期（容器天然兼容）

- confine 读边界/denyRoots 全部由 cfg 派生（`dbPath` 目录+cwd，`src/index.ts:327`）；MSYS 归一在 posix 下 no-op（`sensitive-read-guard.ts:54`）——跨平台自洽，无需改。
- 单实例锁 `donger.lock` 在 DB 同目录（**迁移脚本在 staging 内清锁**，防 rehearsal 期间生产 PID 活跃导致容器拒启）；SIGTERM 优雅退出（停调度→冲审计→停 HTTP→exit 0，`src/index.ts:638-647`）；启动 restart-sweep——与容器 stop/start 语义完全契合。
- 定时任务/事件泵/触发器全进程内，无 Windows 计划任务依赖；「重启服务」=agent 经 SSH 管远端主机，与部署机解耦。
- schema 迁移仍随启动执行（既有行为），镜像升级=容器首次启动跑迁移。

### 2.4 宿主环境

- Docker Desktop 4.85 / engine 29.6.2（WSL2 backend，linux/amd64）；生产 data 2.1GB（大头是历史手工 .db 备份，活跃状态远小于此）；宿主 node v24.20.0；宿主 shell=Git Bash（**迁移/备份脚本用 bash**，本会话实证 powershell.exe 段错误一次）。

## 3. 目标架构

### 3.1 拓扑（compose 单服务，栈目录 `D:\deploy\donger-docker\`）

```
Windows 宿主（DDNS 不变，路由器 3330 转发不变）
└─ Docker Desktop (WSL2)
   └─ compose: donger
      ├─ app 容器 donger:<ts>          node:24-slim，单进程 node dist/index.js（USER node）
      │    API + web 静态 + HTTPS 3330（证书进程内终结，与现在一致）
      ├─ bind: D:\deploy\donger-docker\data      → /data（DB+workspace 全部状态）【D1 拍板】
      ├─ bind ro: D:\deploy\donger-docker\certs   → /certs（现网证书三件套）
      ├─ bind ro: D:\deploy\donger-docker\gitconfig → /home/node/.gitconfig（user+github 代理+safe.directory）
      └─ env_file: donger.env（业务/密钥键，密钥不进镜像）
对外：0.0.0.0:3330 → 容器 3330，SSE 直连无代理层
演练栈：D:\deploy\donger-rehearsal\，端口 3331，容器名 donger-app-rehearsal，与生产互不相扰。
```

### 3.2 镜像设计（`deploy/Dockerfile`，已实体化）

- 两阶段 `node:24-slim`；builder 内 `ENV NPM_CONFIG_REGISTRY=npmmirror` + better-sqlite3 二进制镜像（本机网络现实）。
- 三个已实证坑的处理：web 依赖先装（根 lock 含 `"donger-web": "file:web"`）；`SHELL=/bin/bash`；`tzdata + TZ=Asia/Shanghai`。
- 构建 CONTEXT 裁剪用 **`deploy/Dockerfile.dockerignore`**（BuildKit 按 Dockerfile 命名的忽略文件；放 `deploy/.dockerignore` 不生效——上下文是仓库根）。
- 非 git 资产经 `deploy/stage.ps1` 备料到 `deploy/assets/`（gitignored）：zcode CLI（86MB 纯 JS，glm 目录实测无凭证）与 `.superpowers`。
- 构建期自检步：`better-sqlite3(':memory:')`——linux/amd64 预编译二进制失败即断构建。
- `USER node`（官方镜像自带 uid 1000，**不可再 useradd 1000**——首建实锤 `UID 1000 is not unique`）。
- 密钥零入镜；`CMD ["node","dist/index.js"]` exec 形式，node 为 PID1 直收 SIGTERM。

### 3.3 数据落盘（D1 已拍板：bind mount）

- 决策：`./data:/data` bind mount，数据直接可见于 `D:\deploy\donger-docker\data`，备份/应急直达宿主盘。
- **已知风险与把关**：SQLite WAL 在 Docker Desktop 的 9p 协议上有锁/共享内存语义的历史问题。把关三件套：
  1. M0 专项压测（`scripts/m0-wal-stress.cjs`）：事务写入+并发读+周期 integrity_check+kill -9 崩溃恢复，实测本机 Docker 版本的 WAL×9p 行为；
  2. 迁移演练即全链路压测：rehearsal 容器在真实 bind mount 上跑真数据真写入；
  3. **回退口径（一行改动）**：若压测/运行中出现 DB 损坏，仅将 compose 中 `DB_PATH` 改指 named volume（`donger-db:/db` + `DB_PATH=/db/donger.db`），workspace 保持 bind mount——混合形态，无需重做迁移。
- 运维纪律：容器运行期间**禁止在宿主侧直接写 DB 文件**（备份一律走 `docker-backup.sh` 的容器内 `.backup()`，锁语义同侧）。

### 3.4 配置注入

- `donger.env`（由生产 `.env` 机械派生，`docker-migrate.sh` 自动生成）：**删除**路径与遗留键（`PORT/WEB_PORT/HOST/WORKSPACE_DIR/DB_PATH/MEMORY_DIR/REPO_ROOT/HTTPS_*/SUPERPOWERS_PLUGIN_PATH/PUBLIC_BASE_URL(空)`），其余键逐字保留；文件尾追加容器路径值。
- 栈目录 `.env`（compose 插值）：`DONGER_IMAGE_TAG` / `DONGER_PORT` / `DONGER_SLOT_SUFFIX`。
- `gitconfig` 最小集生成：`[user]` 身份 + github 代理（`127.0.0.1`→`host.docker.internal`）+ `[safe] directory=*`（bind mount 文件属主映射所致 dubious ownership）；**不含** credential helper/lfs filter/editor 等 Windows 段。
- `jwt_secret`/`module_config_secret_key`/`skill_secret_key` 在 DB 内随库迁移，无种子漂移问题。

### 3.5 备份（D4 已拍板：任务计划程序每日 03:30）

- `scripts/docker-backup.sh`：容器内 `better-sqlite3 .backup()` 导出一致 DB 快照 + tar workspace → `D:\deploy\backups\<ts>\`，保留 14 份。
- 例行化：任务计划程序每日 03:30 执行（安装命令见 docs/deploy-docker.md）；重大操作（升级/回滚）前手工触发。

### 3.6 升级与回滚的日常形态

- 升级：`git pull` → `deploy/stage.ps1` → `docker build -t donger:<ts>` → 改栈 `.env` 的 `DONGER_IMAGE_TAG` → `docker compose up -d`。
- 回滚：`DONGER_IMAGE_TAG` 切回旧 tag → `up -d`（旧镜像保留在本机）。
- `runner.ps1` 保留在仓但标注"已由 Docker 取代"，冻结期（两周）内可作最后逃生通道。

## 4. 实施计划与状态

### M0 Spike —— D2/D1 实证

1. zcode CLI 容器内跑通（app-server 启动+协议应答；plugin win32 原生依赖是否致命）→ D2
2. 镜像构建自检（better-sqlite3 预编译/codex linux 二进制/bash/健康检查）
3. WAL×bind mount 专项压测（`scripts/m0-wal-stress.cjs`）→ D1 把关第 1 关
结果：§8.1

### M1 容器资产（已完成，as-built 文件清单）

```
deploy/Dockerfile               deploy/Dockerfile.dockerignore    deploy/compose.yaml
deploy/stack.env.example        deploy/donger.env.example         deploy/stage.ps1
scripts/rewrite-db-paths.cjs    scripts/docker-migrate.sh         scripts/docker-backup.sh
scripts/m0-wal-stress.cjs       docs/deploy-docker.md
```

口径修正两处（相对设计稿）：迁移/备份脚本用 **bash**（.ps1 在本会话实证段错误；Git Bash 为既定 shell）；`.dockerignore` 落位为 `deploy/Dockerfile.dockerignore`。
可选一行代码改动（未实施，随下次发版）：`src/index.ts:319-322` /tmp 文案平台中性化。

### M2 迁移与切换（停机窗口 ≤30 分钟）

1. 前置：镜像 tag 就绪、演练（`--rehearse`，端口 3331）全过。
2. **演练**：`scripts/docker-migrate.sh --rehearse --image donger:<ts>`——staging 拷贝活数据（DB 三件套+workspace，**清 donger.lock**）→ 容器内路径改写（事务+断言）→ 装配 certs/env/gitconfig/compose → 3331 起 rehearsal 容器 → 结构冒烟。生产全程不停。
3. **真切换**：`scripts/docker-migrate.sh --execute --image donger:<ts>`——先停 3330 旧进程 → 同上流程落到 `D:\deploy\donger-docker` → M3 交互冒烟。
4. **回滚预案**：`cd D:\deploy\donger-docker && docker compose down` + 旧 `runner.ps1` 重启（旧目录与旧库全程未动；演练/切换写的是拷贝）。

### M3 冒烟清单（真切换后全过才算完成）

- [ ] HTTPS 证书生效、域名可达（DDNS/端口转发零改动验收）
- [ ] 登录三通道：邮箱 / GitHub OAuth / 钉钉扫码（回调域不变）
- [ ] 三引擎各一轮真实对话：claude / codex（沙箱非降级）/ zcode（app-server + MCP kb 工具）
- [ ] 附件上传+Read；技能 git 私仓安装与执行；知识库检索
- [ ] 审批卡 E2E（MCP send_message + SSE 审批卡 + respond）
- [ ] 定时任务/事件触发器各真实触发一次
- [ ] `docker restart` 后：restart-sweep 正常、会话恢复（transcript 反查）
- [ ] 钉钉机器人外网消息进站；审计/usage 页数据完整
- [ ] 内置技能 delta（D6）：7 个 repo 技能首次可见，确认保留
- [ ] 容器内 github 可达性（host.docker.internal 代理；不可达则宿主代理开 Allow LAN）

## 5. 风险清单（拍板后口径）

| # | 风险 | 对策 |
|---|---|---|
| R1 | SQLite WAL × 9p（D1 已选 bind mount，风险自担） | M0 压测 + 演练实测；**回退口径=仅 DB 切 named volume 一行改动**；宿主侧禁直写 DB |
| R2 | zcode plugin win32 原生依赖（sharp/koffi） | M0 spike 实证；失败则容器期隐藏 zcode 引擎选项（D2 预案） |
| R3 | better-sqlite3 / codex 的 linux 二进制缺失 | Dockerfile 构建期自检步 |
| R4 | Docker Desktop 生命周期依赖登录会话 | 自动登录+开机自启 + `restart: unless-stopped`；备选路线（不在本期）=WSL2 内原生 docker-ce |
| R5 | 时区/locale | TZ=Asia/Shanghai + LANG=C.UTF-8 烘入镜像 |
| R6 | WSL2 VHDX 膨胀 | 半年 compact；数据主体在 D 盘 bind mount，受影响面小 |
| R7 | host_exec 白名单语义：agent 的"本机"=容器 FS | 前缀机制不变；运维查日志改 `docker logs donger-app`；confine homeDir 边界不变 |
| R8 | 切换时 3330 端口冲突 | execute 模式先停旧进程；演练用 3331 + 独立栈目录 + 清 lock |
| R9 | 非 git 资产不进构建上下文 | `deploy/stage.ps1` 备料 + `Dockerfile.dockerignore` |
| R10 | 生产 src 长期漂移 vs git 构建 | 迁移冒烟对齐现网特征；迁移后真源唯一=git，漂移源消失 |
| R11 | 宿主代理（Clash 127.0.0.1:7897）对容器不可达 → 容器内 github 失联 | gitconfig 译为 host.docker.internal；需宿主代理开 Allow LAN（切窗口验证项） |

## 6. 明确不做

不引入 K8s/云端/多副本；不换数据库；不做镜像 registry 与 CI 出镜像（D5 本机构建）；不动鉴权/审批/审计面；不搬历史手工备份（留在冻结的旧目录）。

## 7. 拍板记录（2026-10-11）

| # | 决策 | 用户裁决 |
|---|---|---|
| D1 | 数据卷形态 | **bind mount**（推翻建议的 named volume；R1 三件套把关+一行回退口径兜底） |
| D2 | zcode 引擎口径 | 同意（spike 通过=三引擎全量；不过=容器期隐藏 zcode 选项） |
| D3 | 切换窗口与旧目录退役 | 同意（低峰窗口一次性切换 ≤30 分钟；旧目录冻结两周后退役） |
| D4 | 备份例行化 | 同意（任务计划程序每日 03:30 → `D:\deploy\backups`，保留 14 份） |
| D5 | 镜像构建位置 | 同意（本机手动 `docker build`） |
| D6 | `BUILTIN_SKILLS_DIR=/app/skills` 行为 delta | 同意接受（7 个内置技能首次真实生效） |

## 8. 实施与验证记录（2026-10-11 实测）

### 8.1 M0 验证结果

- 镜像构建：`donger:m0-smoke` 509MB（node v24.21.0）。三处构建期实锤与修正：① `useradd -u 1000` 撞官方镜像内置 `node` 用户 → 改用内置用户；② npmmirror registry + better-sqlite3 二进制镜像 ENV（本机网络）；③ `deploy/.dockerignore` 不生效 → 必须 `deploy/Dockerfile.dockerignore`（上下文为仓库根）。
- 容器冒烟：bash/SHELL=/bin/bash/git 2.39.5/健康路由/内置技能目录 ✅；codex linux 二进制 `codex-cli 0.155.1` + 自带 rg ✅（在 `@openai/codex-linux-x64/vendor/.../bin/codex`）。
- zcode spike（D2）**通过**：CLI 纯 JS 容器内可跑；缺 `provider/zcode-builtin.json` 时拒绝启动 → 该文件在 `resources/config/provider/`（188KB，含疑似凭证 → **不烘镜像**，migrate 拷入栈目录 compose 只读挂载至 `/opt/zcode-cli/provider/`）；补齐后 app-server 启动、NDJSON 协议应答、自带 22 个会话库迁移跑通。
- WAL×bind mount 压测（D1 把关）**通过**：14,327 rows/s（事务写+并发读+周期 integrity_check）、busy=0；kill -9 崩溃注入后重开 integrity ok、WAL 恢复一致。
- MSYS 两坑（Git Bash 调 docker/robocopy）：路径改写须 `MSYS_NO_PATHCONV=1`；`MSYS_NO_PATHCONV=1` 下 robocopy 旗标必须单斜杠。

### 8.2 M2 演练结果（3331，生产未停，全流程通过）

- staging 拷贝 373MB/16,968 文件 19s；`rewrite-db-paths.cjs`：**7/7 用户改写**（相对 1 + 旧绝对 6 → `/data/workspace/users/<id>`），断言零残留 + integrity ok。
- 解除武装：workflows enabled→0；`event_firings` 实为记录表非队列（无 status 列，无残留风险）。
- 容器 5s 健康启动；结构冒烟：web bundle/401 鉴权/数据对账（82 会话、1084 消息、10,545 审计、3 技能包、12 知识库）全过。
- **真引擎验证（claude 全链路）**：自签 JWT → 建会话 → 发消息 → **bot 回复「演练成功」**，落库一致。
- 演练揪出并修复 3 个真实缺陷：
  1. P0 权限：`/app/skills` 镜像内 root 属主，引擎物化 `.donger-sdk-plugin` EACCES → Dockerfile chown node（`src` 零改动）。
  2. 潜伏 bug（与容器无关，D6 让其首次可见）：`sdk-plugin-layout.ts` 根级 SKILL.md 包形态整目录 cpSync 命中「拷入自身子目录」→ 逐条目拷贝跳过生成目录（内置目录 `<slug>/SKILL.md` 每技能一目录形态首次真实生效就踩中）。
  3. P0 Windows 硬编码（安全内核 M1 引入）：`claude-agent-runner.ts` apiKeyHelper `cmd /c type` 与 `zcode-agent-runner.ts` 守卫 hook `cmd /c curl … exit /b 2` 在 Linux 直接失效（前者断 LLM 鉴权、后者废 zcode 审批守卫）→ 双双补 posix 分支。
- 回归：`sdk-plugin-layout` 5/5、claude+zcode runner 48/48 全绿（tsc 报错为在案测试基线，与本次无关）。
- 演练栈保留在 `D:\deploy\donger-rehearsal`（3331，已解除武装）可人工查验；`cd /d/deploy/donger-rehearsal && docker compose down` 即清。

### 8.3 待办（真切换 = 纯运维动作）

`scripts/docker-migrate.sh --execute --image donger:<ts>`（D3 低峰窗口）→ M3 冒烟清单（OAuth/钉钉回调、zcode/codex 真轮、审批 E2E、触发器、内置技能 delta、github 代理连通）→ 旧目录冻结两周后退役。

### 8.4 真切换记录与后续事件（2026-10-11）

- **真切换完成**：`--execute` 一次通过（中途 taskkill `//F` 被 `MSYS_NO_PATHCONV=1` 原样传入被拒，修复为单斜杠后重跑），容器 5s 健康。冒烟：claude/zcode 真轮均回复成功；数据对账一致；测试数据已清理。备份任务计划 `donger-docker-backup`（03:30 每日）安装+首备实测通过。镜像 tag=`donger:20261011-1857`，代码推双远端 0e09d8f。
- **homedb 连接回归（切换后首个事件，已修复）**：会话 7d31ef7f 检查部署时 ssh-homedb 六次握手超时。根因=**Docker NAT 出站不走 OpenVPN 隧道路由**（目标 192.168.1.103 在 VPN 后：宿主 17ms 连上 vs 容器永久超时；容器到宿主双 IP/路由器均正常，唯独 VPN 网段不可达）。修复=宿主 portproxy `10.9.101.78:2222→192.168.1.103:22` + `ssh-homedb` 凭证值改指宿主转发（API PUT 合并语义，认证材料无损）；agent 端到端验证拿到目标机真实 uptime。次级发现：`homedb.jeandom.com` 全靠 Windows hosts 钉值解析（路由器 DNS 为 NXDOMAIN）；会话中 agent 对凭证值的更新（→.101）是真实的但目标 IP 本身错误（.101 无 sshd），hosts 表不参与端点解析（端点在凭证值里）。

### 8.5 生产 e2e 验证记录（2026-10-12 凌晨）

通道：MCP send_message + SSE 审批卡 + HTTP respond（沿用 deploy-ops 轮），适配容器化 DB 路径，脚本 `.tmp/e2e-prod-docker.mjs` 系。

| 项 | 结果 |
|---|---|
| MCP 通道（dgk_ 令牌/initialize/tools-call，11 工具面） | ✅ |
| host 只读链路（hosts_list/host_status 免审批） | ✅ 真实回传 Ubuntu 22.04/磁盘 16%/ClickHouse 等服务状态 |
| **审批卡 E2E**（SSE 抓卡→HTTP 批准→远端执行→结果回传） | ✅ 写命令先被写边界正确拦截，相对路径重试弹卡、批准后执行成功 |
| host_exec 只读白名单 | ✅ `echo`/`systemctl is-active` 均免审批直执行 |
| github 连通 | ✅ 容器内 `git ls-remote github` 走挂载 gitconfig 成功，直连 TLS 也通（Allow LAN 顾虑解除） |
| KB 通道 | ✅ list_knowledge_bases + search_knowledge_base 直调命中真实库内容 |
| 附件通道 | ✅ 上传落规范容器路径 + agent Read 原样回传标记（首次走裸会话被调度器转 Agent Builder，agent 会话才是正确形态） |
| **定时工作流自然触发** | ✅ 23:00 `stock-analysis运维` 按调度真实触发（触发/泵/agent/汇报全链路；当次因下述回归失败，属凭证问题非平台问题） |
| restart 韧性 | ✅ SIGTERM 优雅关闭→5s 健康→scheduler 还原→数据一致→**既有会话引擎续轮成功**（会话内定时任务不跨重启=既定语义） |

**事件：凭证值被改回直连导致回归**。首轮 e2e 失败排查发现 `ssh-homedb` 凭证值在 22:44 被改回 `192.168.1.103:22` 直连（凭证页无审计留痕，疑手工"纠正"），22:45 与 23:00 两次巡检因此全部失败。已重新 PUT portproxy 端点，并把警示写进凭证别名（「容器必经宿主portproxy 10.9.101.78:2222，直连IP必超时勿改」）。**铁律：该凭证 host/port 指向宿主 portproxy，改回直连 IP 必然复发**。

清理：5 个验证会话、9 个临时 JWT（revoked_tokens）、13 个 e2e 命名 MCP 令牌已删，生产余 85 会话全为真实数据。待外部确认项：邮箱/GitHub/钉钉 OAuth 真实外网回调。
