# 网站游戏开发闭环：完整技术方案与开发计划

- 日期：2026-11-04
- 状态：M1+M2 已实施（分支 feat-20261104-webgame-dev-loop）；M3 按需；详见 §4b 实施状态
- 前置：关键技术可行性验证（四项 spike）当日完成，全部通过，见 §2
- 关联：`docs/app-platform-retired.md`（应用平台永久作废，本方案不重启应用托管）；`spec 2026-10-30-workflow-dedup-design`（挂载链模式参考）

## 1. 目标与闭环定义

在 donger 平台上支撑「网站/游戏开发」业务闭环：

1. **git 代码管理**：agent 对话内完成项目代码的读写与提交推送；
2. **e2e 浏览器验证**：agent 用浏览器（类 codex/zcode 的 browser use）驱动真实页面完成验证，过程可见；
3. **成果预览**：用户在平台内直接预览开发成果（网页/游戏可交互）。

闭环链路：用户发需求 → agent 会话写码（会话 worktree）→ 起 dev server → Playwright e2e + 截图证据 → 修复迭代 → `donger-git` push（force 门审批）→ 用户平台内 iframe 预览 → 反馈/继续迭代（工作流可编排，反馈单回写复用既有设施）。

## 2. 关键技术可行性验证（spike 实证，2026-11-04）

四项 spike 全部通过，脚本留档 `scripts/tmp-spike-*.cjs/.mts`：

| # | 验证项 | 结论 | 关键证据 |
|---|---|---|---|
| S1 | Playwright MCP stdio 独立可用 | **通过** | `npx @playwright/mcp@latest --headless` 握手（proto 2025-06-18）、25 个 browser_* 工具、navigate(data:URL)、a11y 快照、截图落盘 PNG 1280×720 |
| S2 | donger 真机会话挂 MCP 驱动浏览器 | **通过，零代码改动** | admin API 建测试 agent（`mcpServers:[{type:"stdio",command:"npx",args:[...]}]`）→ 发消息 → agent 自主调用 browser_navigate/browser_take_screenshot → 正确回答页面标题与截图绝对路径 |
| S3 | 平台托管 dev server + 同源反代 | **通过** | 沙箱 vite 项目（npm install 20s）→ 平台 spawn（固定口）→ node 反代（动态口，http + WS upgrade 隧道）→ 无头浏览器经代理渲染断言 + 截图 → HMR 信号穿代理送达 → taskkill 树杀端口释放 |
| S4 | 截图/预览回读链路 | **图片通过，html 需专用通道** | `/api/files/content` 回读截图 200 + `image/png` 内联（无 Content-Disposition），端到端字节数一致；文件树（scope=runtime）可见 agent 全部产物含 `.playwright-mcp/` 轨迹；**html 被强制 `text/plain`（防同源执行策略），静态页预览必须走专用反代通道** |

### 2.1 spike 抓出的硬约束（进设计）

1. **版本钉版**：`@playwright/mcp@latest`(v1.65) 默认要 `chrome-for-testing`(chromium-1252)，与既有缓存不匹配即报错。镜像与宿主机都必须**钉版安装**：`npx @playwright/mcp@<ver> install-browser chromium`，或用 `--executable-path` 直连固定路径（spike 采用后者）。
2. **截图落点 = MCP 进程 cwd**：playwright MCP 把截图/轨迹写到自身 cwd；donger 引擎 spawn MCP 时 cwd=会话工作区 → **截图与轨迹自动落会话工作区，文件树天然可见**（`~/.donger/workspace/users/<owner>/agents/<agentId>/workspace/`）。这是「过程可见」的零成本通道。
3. **图片默认不内联**：v1.65 截图返回文本链接而非 image block（`--image-responses` 可调）。对话卡内直接看图需动 tool_result 渲染链（M3 打磨项），M1 用文件树预览顶替。
4. **zcode 引擎静态核证**：env 白名单保留 `PATH/APPDATA/LOCALAPPDATA`（stdio `npx` 可解析，`zcode-agent-runner.ts:311-334`）；`ZCODE_NO_BROWSER=1` 只关原生浏览器通道，不影响 MCP 工具面 → **不必重开「决策点②」**。zcode/codex 的 MCP 透传真机冒烟列入 M1 验收。
5. **dev 环境注意事项**：dev 后端是 `tsx watch`，并行会话改 src 即重启（本次轮询撞上两次）；生产单进程无此问题。并行会话协作时避免长轮询依赖 dev 后端稳定。

## 3. 架构设计（复用既有抽象）

沿平台既定原则：**平台只拥有资产 + 通道 + 治理**；业务方法论进仓库与技能，执行进 agent 会话。不新建子系统，不重启应用平台。

```
资产层   开发项目 = git agent 实例化（模板：仓库凭证 + 技能 + MCP 挂载 + 权限模式）
         每对话自动落会话 worktree（9b96a80 既有），分支 session-<convId>
执行层   agent 会话：写码 → bash 起本地服务（localhost 已在 INV-8 白名单）
         → playwright MCP e2e（a11y 树 + 截图落 cwd）→ donger-git push（git-write force 门）
通道层   [新增·M2] dev-runtime 通道：平台托管 dev server（listen(0) 临时端口）
         + GET /preview/:convId/* 同源反代（含 WS）+ GC 生命周期联动
治理层   三档权限模式 + force 门（push/deploy 不豁免）+ 审计；
         [新增] dev server 并发上限/闲置回收/排水期拒启
```

### 3.1 需求一：git 代码管理（现状 90%，补两件）

- **项目实例化**：新建「开发项目」= 用 agent 模板创建 git agent（绑仓库凭证 + gitRepositories）。会话 worktree 隔离、`donger-git` 凭证桥、git-write/deploy force 门全部既有（`default-gates.ts:50-74`）。
- **补件 1·忙互斥**：`runtime-manager.ts:277` 自知未实现——同 agent 并发轮写同仓。加 per-agent 简单锁 Map（排队或 409 提示）。
- **补件 2·项目模板**：见 §3.4。

### 3.2 需求二：e2e 浏览器验证（零代码起步 + 两个硬化件）

- **M1 形态（已实证）**：agent 级 `mcpServers` 配 playwright stdio。为免每个项目手工配置与版本漂移，沉淀为**平台 agent 模板**（§3.4）+ 一份「网页开发方法论」技能（写清：起服务方式、截图文件名约定子目录 `.shots/`、`--image-responses` 语义、push 规范）。
- **硬化件 1·浏览器钉版**：Dockerfile 增 `npx @playwright/mcp@<钉版> install-browser chromium`（镜像 +~300MB）；宿主机 dev 同命令一次性装。MCP 版本与镜像同步钉版，升级走镜像发布。
- **硬化件 2·三引擎冒烟**：claude 已真机过；zcode（session/create 原生 mcpServers）与 codex（桥列表）按既有挂载链各跑一条冒烟用例。
- **过程可见分级**：M1=截图落 `.shots/` + 文件树预览（现成）；M3 可选=tool_result 图片通道（`event-bridge.ts` outputPreview 旁增 images 字段 → webChat → ToolCard `<img>`，四层小改）。实时直播画面（CDP screencast）不进任何分期，用预览 iframe + 截图证据替代。

### 3.3 需求三：成果预览（唯一架构级新增 = dev-runtime 通道）

**形态**：平台托管、同源反代、会话级生命周期。复用既有先例：`McpHttpBridge` 的 `listen(0,"127.0.0.1")` 临时端口、web-channel 路由守卫、worktree-gc 清扫钩子。

- **工具面**（in-process MCP server「dev-server」，模式同 workflow-dedup）：
  - `dev_start({dir?, cmd?})`：默认读 cwd `package.json` 的 `dev` script；平台 spawn（绑 127.0.0.1，`listen(0)` 随机口），登记 session_runtime；
  - `dev_status/dev_url/dev_logs({tail})`/`dev_stop`；
  - 返回的 url 为平台同源相对路径 `/preview/<convId>/`，agent 把它写进回复与验收说明。
- **反代路由**：`GET /preview/:convId/*`（authenticated + 会话属主/被分享口径校验）→ 按 convId 查 session_runtime 端口转发，透传 WS upgrade；SPA fallback 由 agent 侧 vite/next `base: './'` 约定吸收（写进技能）。
- **数据模型**：`session_runtime`（PK convId；port/cmd/pid/startedAt/lastAccessAt/status）。进程不跨重启恢复：启动时全量标记 stale 由 GC 清。
- **生命周期**：worktree-gc sweep 时顺带 kill + 清行；闲置（无请求 30min，可配）回收；热发布排水期拒绝新 start（复用 drain.shouldRejectNewTurn 口径）；全局并发上限（建议 4）+ 每用户上限（建议 2）。
- **安全**：仅 loopback 绑定；反代仅同源路径 + JWT；iframe 内嵌平台页（同源无跨域问题）；预览进程属平台子进程不进 agent 能力集，杜绝 agent 互 kill。

### 3.4 资产模板：「网页/游戏开发」agent 模板

一键实例化的模板（管理面既有 agent 创建流的预置形态）：
- `gitRepositories` 绑定项目仓库 + 凭证模板；
- `mcpServers`: playwright stdio（钉版，容器内免 executable-path）；
- `defaultPermissionMode`: `full_access`（或 risk_guard，拍板点 3）；
- `skills`: 「网页开发方法论」（dev/e2e/截图/预览/push 流程 + vite base 约定 + 截图落 `.shots/`）；
- `systemPrompt`: 身份 + 验收纪律（每轮变更必须 e2e 截图留证后才允许 commit）。

游戏开发特化（M3）：补挂 chrome-devtools-mcp（CDP console/network/性能 trace，canvas 游戏断言弱时的调试面）；模板二「游戏开发」。

## 4. 分期计划

### M1 · e2e 闭环（近零代码，1-2 天）
1. 宿主机/镜像浏览器钉版安装（`install-browser chromium`）；
2. agent 模板 + 网页开发方法论技能（平台资产，非代码）；
3. zcode/codex 引擎 MCP 透传真机冒烟各一条；
4. 验收样板：spike 会话同款——发需求 → agent 写码 → 起 vite → playwright 截图 → git push（force 卡）→ 文件树看截图。

### M2 · 预览通道（2-4 天，动码）
1. `session_runtime` 表 + store（迁移幂等补列模式）；
2. dev-server in-process MCP（4 工具，挂载链仿 dedupTools）；
3. `/preview/:convId/*` 反代（http+WS，属主守卫，含 SPA fallback 透传）；
4. GC 联动回收 + 并发上限 + 排水拒启 + lastAccessAt 续期；
5. web：对话页/文件页「预览」iframe 入口（复用文件预览弹窗壳）；
6. busy mutex（runtime-manager.ts:277）；
7. Dockerfile chromium 钉版 + e2e：单会话起停/双会话并发上限/GC 回收/属主 403。

### M3 · 编排与打磨（按需）
1. 「网页开发闭环」工作流模板（业务轮指引 + execution.completed 级联验证轮可选 + feedback_add_reply 回写，dedup 防重入）；
2. tool_result 图片渲染通道（event-bridge→webChat→ToolCard）；
3. chrome-devtools-mcp 游戏特化模板；
4. GitOps 发布挂钩（对外发布走既有外接部署形态，预览≠发布）。

## 4b. 实施状态（2026-11-04 更新）

**M1 + M2 已在分支 `feat-20261104-webgame-dev-loop` 实施**（基于 origin/master daf1bf6，worktree 开发）：

- M1.1 浏览器钉版：宿主机 `@playwright/mcp@0.0.84`（与本机 chromium-1228 直接配对，免 executable-path）+ Dockerfile 同版钉装。
- M1.2 方法论技能：`skills/webgame-dev/SKILL.md`（随内置技能分发）。
- M1.3 双引擎真机冒烟（2026-11-05，隔离实例=worktree 合并码+临时库+3310，智谱 token 造 provider，spec 附录见 scripts/tmp-smoke-dual-engine.mts）：
  - **zcode 引擎 PASS**：stdio MCP 经 session/create 原生透传真机可用——agent 自主 browser_navigate+browser_take_screenshot，PNG 1280×720 落 `.shots/`（worktree 内），汇报含标题与相对路径。两个调优发现：①playwright MCP 托管 chrome 配置目录会被并发实例锁（`Browser is already in use`）——**MCP 参数必须加 `--isolated`**（参考配置已更新）；②zcode 会话 env 白名单下 npx 解析/浏览器解析慢会拖死 MCP 初始化（180s 超时）——用 `command:"node"` 直跑 cli.js + `--executable-path` 直连后秒起。
  - **codex 引擎：冒烟 FAIL → 专项修复后 PASS（2026-11-05 同日收口）**。冒烟根因链：配置链全通（donger 命令行实送 `mcp_servers.playwright`、`codex mcp list` enabled、rmcp 握手成功），但 codex 0.155 把 MCP 工具暴露为 **namespace 型聚合工具 `mcp__playwright`**（mock 实捕 `"type":"namespace"`），donger 桥 `codex-chat-bridge.ts` 只映射 `type:"function"` → 工具被丢、模型永远看不到；修复候选证伪：dot 名调用路由拒（`unsupported call`）、`features.tool_search_always_defer_mcp_tools=false` 无效（新版退役开关已被解析器拒绝）。
  - **修复形态（协议实验 `scripts/tmp-mock-probe.cjs` e1 实证）**：桥内联工具环——runner 把 MCP 工具面（in-process 平台工具台 + agent 连接器 stdio/http）注册给桥的 `BridgeToolExecutor`（新文件 `bridge-mcp-client.ts`：InMemory/Stdio/StreamableHTTP 三传输客户端，懒连接+超时守卫），桥把工具展平为 `mcp__<server>__<tool>` function 工具注入上游 chat 请求，模型 tool_call 命中由桥直接执行并以 function_call+function_call_output 内联回传 codex（codex 不再配置任何 mcp_servers，namespace 路由彻底绕开）。审批门语义保持（executor 内静态拒绝，文案与 mcp-http-bridge 同款）；审计保持（内联对随流经 codex runner 事件管线，tool_result 正常落审计）。
  - **修复验证（隔离实例真机）**：codex 引擎 navigate+截图全链路 PASS（PNG 1280×720 落 `.shots/`，cwd=会话工作区——StdioBridgeMcpClient 显式传 cwd，修掉首版落在后端进程 cwd 的偏差）；**连坐影响一并修复**——donger-host×7/donger-kb×5/dedup 等 MCP 工具在 codex 引擎模型侧全部可见可执行（修复前同被 namespace 语义覆盖而不可用，属平台级存量回归）；测试：桥单测 +4（展平注入/延迟收尾/executor 路由门禁/端到端两轮续推）17/17 绿，runner 测试 8/8 绿，tsc 清零。
- M2 全部 9 项已落地并提交；新增 18 用例全绿（store 4/tools 4/service 6/路由 4，service 与路由为真子进程测试）；后端全量 1886 过，7 个失败文件单跑全绿=存量并行抖动（含非改动面文件，实锤与本次改动无关）；tsc 与 web 构建双清零。
- busy mutex（M2.6）：复核后**不新增**——同会话串行已有 `busyConversations` 排队、跨会话同 agent 冲突由会话 worktree 隔离（默认开）消解；runtime-manager 遗留注释已改写为当前事实。
- 参考项目 agent 配置（部署后创建，字段 `devPreviewEnabled: true` 旧后端会静默剥离，必须在分支部署后建）：

```json
{
  "name": "网页开发工坊",
  "description": "绑定项目仓库的网站/游戏开发智能体（dev_* 工具 + playwright e2e + 平台预览）",
  "gitRepositories": [{ "name": "<项目仓>", "credentialTemplate": "<git 凭证模板 code>" }],
  "mcpServers": [{ "name": "playwright", "type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@0.0.84", "--headless", "--isolated"] }],
  "skills": ["webgame-dev"],
  "defaultPermissionMode": "full_access",
  "devPreviewEnabled": true
}
```

- 生产部署注意：容器内 MCP 参数须加 `--no-sandbox`（非 root + 无 user namespaces）；镜像 chromium 层待下次构建实测（本次未构建镜像，C 盘空间约束）。

## 5. 测试计划（M2 动码部分）

- store：session_runtime 增查/并发 start 唯一/stale 清理；
- 工具：dev_start 幂等（已起返回同 url）/上限拒绝/stop 后 port 释放；
- 反代：200 透传/属主 403/未知 conv 404/WS upgrade/上游死 502；
- 生命周期：闲置回收/GC sweep 联动/排水期 503；
- 引擎冒烟：claude/zcode/codex 三引擎各一条 playwright 截图用例；
- e2e：全链路（同 M1 验收样板 + iframe 预览断言）。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 多会话并行 dev server 内存（Windows 单机） | 全局/每用户上限 + 闲置 30min 回收 + 排水拒启 |
| npx 首次拉包延迟进轮次 | 镜像/宿主预热钉版（MCP 包 + 浏览器），技能内禁用 @latest |
| 子路径反代与 vite/next base 不匹配 | 技能约定 `base:'./'` + relative 路由；M2 e2e 断言 |
| canvas/WebGL 游戏 a11y 断言弱 | 截图比对 + console 断言 + M3 chrome-devtools-mcp 性能面 |
| 同仓并行会话互斥缺失 | M2 busy mutex |
| MCP cwd 落盘文件名冲突 | 技能约定子目录 `.shots/` + 轮次时间戳文件名 |
| tool_result 纯文本看不到截图 | M1 靠文件树；M3 图片通道 |

## 7. 拍板点

1. **MCP 挂载形态**：agent 模板实例化（推荐，零代码、资产化）vs 平台级 browserTools 自动挂载（orchestrator 三引擎各一行，强制全员携带）；
2. **dev server 托管方**：M2 平台 dev-server MCP 工具托管（推荐，可治理）vs 永远 agent bash 自管（零代码但无上限/回收/URL 注入）；
3. **项目模板默认权限模式**：full_access（顺滑，推荐内网单机）vs risk_guard（每次写/push 弹卡）；
4. **并发与回收参数**：全局 4 / 每用户 2 / 闲置 30min（建议值，可改配置化）；
5. **tool_result 图片通道**：M3 做或不做（不做则截图永远走文件树）。

## 8. 与既有决策的边界

- **不重启应用平台**：预览是会话资产视图（进程与 GC 挂会话），不是应用托管；对外发布仍走 GitOps 外接（M3 挂钩可选）。
- **不动「决策点②」**：zcode 原生浏览器通道维持关闭；e2e 走 MCP 工具面，语义正交。
- **复用清单**：会话 worktree、donger-git、force 门、INV-8 localhost 白名单、McpHttpBridge listen(0) 惯例、workflow-dedup 挂载链模式、文件树/预览弹窗、worktree-gc、排水期守卫、反馈回写设施。
