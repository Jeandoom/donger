# 部署运维闭环设计（L1：SSH 通道 + 出站轮询触发）

日期：2026-09-30 ｜ 状态：已拍板实施（L1）

## 1. 背景与目标

基于 donger 的 agent 能力对服务做闭环管理（需求 → 设计 → 开发 → 验证 → 部署 → 使用）。两个断点：

1. **部署触发**：部署机经 SSH 访问管理，代码推送后无自动部署入口。git 托管平台不唯一
   （github / gitee / jihulab / 自建），webhook 不可依赖——**触发必须 donger 主动**。
2. **机器运维**：日志打满磁盘、请求打满 CPU 需要运维人员专门处理。

## 2. 架构决策（对话定稿）

- **控制面/执行面分离**：donger = 控制面，SSH 目标机 = 执行面，中间一条受控通道 + 受限指令集。
- **一切皆出站**：部署触发 = donger 出站轮询 git 平台 API（复用 `git-platform-api-resolver`
  三平台适配器 + 凭证体系）；donger 不开任何 git 入站端点。目标机侧上报（L2 landside）同样出站。
- **快慢路径分离**：轮询发现新提交 → `autoDeploy=true`（测试环境）纯通道直接执行（零 LLM）；
  `autoDeploy=false`（生产环境）只发站内信通知，人工经 API 或 agent 工具触发（过审批门）。
- **目标登记制**：SSH 工具入参一律 `targetId`，只能对登记过的 deploy_target 执行，防横向移动。
- **受限白名单**：不给裸 shell。host 工具发固定命令模板（tail/df/ps），参数严格校验；
  部署命令是 owner/admin 显式配置的剧本（prepare/restart/healthCheck），字段值（workdir/
  branch/service/ref）以 regex 收口元字符，渲染后整体经 SSH exec。
- **分档**：L1（本 spec）SSH 通道零目标机改动；L2 landside 守护（releases/current 布局 +
  心跳指标推送，复用 2026-09-17 自部署 spec 的 updater 设计，该 spec 在
  `D:\code\donger-oss-backup\wt-self-deploy-design\`，待捞回主仓）；L3 容器化 + 资源限额。

## 3. L1 组件

| 组件 | 文件 | 说明 |
|---|---|---|
| 域模型 | `src/domain/deploy.ts` | DeployTarget / DeployOrder + 字段安全 regex |
| 存储 | `src/adapters/sqlite-deploy-store.ts` | deploy_targets / deploy_orders 两表 |
| SSH 端口 | `src/ports/ssh-command-runner.ts` | 依赖注入端口（测试 mock） |
| SSH 适配器 | `src/adapters/ssh2-command-runner.ts` | ssh2 实现（密码/私钥、超时、输出截断） |
| 执行器 | `src/orchestrator/deploy-executor.ts` | order 状态机 + 互斥 + 通知 |
| 轮询器 | `src/orchestrator/deploy-poller.ts` | 定时查分支 HEAD，diff lastSuccessSha |
| host 工具 | `src/orchestrator/host-tools.ts` | `donger-host` MCP server（8 工具） |
| 审批门 | `src/orchestrator/default-gates.ts` | `host-ops` force 门（full_access 不豁免） |

### DeployTarget 关键字段

`{ name, service, provider, repoUrl, branch, gitCredentialCode?, ssh{host,port,username,credentialCode},
workdir, prepareCommands[1..10], restartCommands[0..10], healthCheck{cmd,expectContains?}?, autoDeploy,
enabled }` —— SSH 凭证走凭证体系 generic 模板（键 private_key/password），git PAT 走 git 模板，
运行时按 target.ownerId 现取，不进 agent 上下文。

### DeployOrder 状态机

`running → success | failed`（步骤级 exitCode/outputTail 落库；启动时 running 全部清扫为 failed）。
`lastDeployedSha` 不单独存：以最后一次 success order 的 sha 为准（单一真源）。

### 轮询器

缺省 120s（env `DONGER_DEPLOY_POLL_INTERVAL_MS`），逐 enabled target 顺序轮询（防并发轰炸）：
getBranch → 提取 HEAD sha（gitee/github `commit.sha`、gitlab `commit.id`）→ 与 lastSuccessSha
比对 → 变化且 autoDeploy → executor 执行；变化且非 autoDeploy → 站内信 `deploy.detected`
（dedupeKey 幂等）。轮询错误 fail-open（log 继续）。

### donger-host 工具集（挂载条件：会话用户为 admin 或名下有 enabled target）

只读免审批：`host_status` `host_disk_usage` `host_process_top` `host_logs_tail` `deploy_status`
`deploy_targets_list`；
写（force 门 `host-ops`）：`service_deploy`（trigger=agent）`service_restart` `host_logs_clean`。

## 4. 安全红线

1. SSH 私钥/密码、git PAT 均经凭证体系按属主解析，任何工具输出/审计/通知不回显。
2. 受限白名单指令集，无裸 exec；模板变量（ref/branch/workdir/service）regex 收口元字符。
3. 写操作三工具挂 `host-ops` force 门（full_access 不豁免，同 deploy/authoring/git-write 先例）。
4. 目标登记制：一切工具调用先解析 targetId 并校验可见性（owner/admin）。
5. 守卫 fail-closed：新路由全部登记 web-route-guards（未登记 404）。

## 5. L2+ 预留（不在本轮）

landside 守护（心跳+指标推 /hooks/landside-<id> → 事件触发器 → 运维 agent 自愈/审批升级）、
releases/current 原子翻布局、部署失败自动回滚、agent 级 host 工具开关（本轮以 target owner
/admin 判定，后续可下沉到 agent 配置页勾选）。
