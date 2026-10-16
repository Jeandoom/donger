# 反馈全自动开发部署 L2 设计（feedback → 分析 → 开发 → 自动合并 → 自动部署 → 闭环）

- 日期：2026-10-16
- 状态：待拍板（未提交未动码）
- 前置分析：可行性轮结论 = 链路四段中「订阅/分析/开发」平台已齐备，「自动合并+自动部署」是 force 门**故意**拦住的一段，L2 = 在门内做策略化自动放行，而不是拆门
- 关联：docs/agent-sdk-prompt-injection-probe-20261010.md（P0 前置）、docs/superpowers/specs/2026-09-17-agent-self-deploy-design.md §3.6（force 门）、2026-10-09-events-workflows-refactor-design.md（事件/工作流）、docs/deploy-docker.md（容器化部署现状）

---

## 1. 目标与非目标

**目标**：一条 `feedback.created` 反馈，经无人值守工作流完成分诊→评估→开发→测试→提 MR，命中发布策略的提案**自动合并、自动构建、演练槽验证、生产切换、失败自动回滚**，并把结果回写到反馈（提交人收到"已修复并发布"回复）；未命中策略的提案降级 L1（审批卡人工）。管理员的角色从"每单审批"退到"策略配置 + 事后审计 + 兜底处理"。

**非目标**：
- 不做 feature 类需求的全自动开发（v1 仅 bug/体验修复类路由进全自动，feature 转人工提案）；
- 不做数据库 schema 变更、依赖升级、安全边界代码变更的自动化（策略硬 deny）；
- 不拆除任何 force 门——L2 是**门内策略放行**，门本身与审批卡兜底路径原样保留；
- 其他产线项目的全自动部署 v1 只留抽象位（§4.8），不实现具体通道。

## 2. 架构原则（两条铁律）

1. **不可信内容永不跨越信任边界**：反馈文本（untrusted）只能驱动"分析与提案"；一切**放行判定**（能否合并、能否部署）必须是确定性代码——纯函数策略引擎 + 宿主脚本，LLM 的输出只是提案输入，永不作为放行依据。模型可以"提议"，只有确定性代码可以"放行"。
2. **爆炸半径白名单化**：沿用 host_exec 白名单的既有哲学（2026-10-10 拍板：命中且无逃逸→自动放行+审计打标，未命中→回审批卡；误放行=绕门、误拦截=回人工，两头不对称偏保守）。force 门原样存在，策略命中的放行必须打 `auto_policy` 标记进审计，策略未命中的行为与今天完全一致（弹卡）。

由此推出一条系统不变量：**master = 生产候选**。宿主管线只认 master（watcher 轮询远端 master SHA），自动合并即部署触发，部署路径上没有任何 LLM 参与；回滚路径不依赖 donger 自身存活（donger 挂了 watcher 照样能回滚——回滚绝不能依赖被回滚的对象）。

## 3. 现状锚点（已核实）

| 能力/缺口 | 锚点 |
|---|---|
| `feedback.created` 是唯一注册系统事件 | src/domain/event.ts:18 |
| 事件发射点（反馈创建时进程内分发） | src/adapters/web-channel.ts:4279-4290 |
| matcher 支持 jsonPathEq/bodyContains/bodyRegex（可按 category 粗筛） | src/domain/event-matcher.ts:39-59 |
| workflow = 事件+agentId+promptTemplate+permissionMode（缺省 full_access，无多步管线） | src/domain/workflow.ts:4-23 |
| 触发执行：每轮独立会话、triggerOutput wrapUntrusted 注入、队列容量 10 | src/orchestrator/event-dispatcher.ts:41,62-93,159-212,229-235 |
| force 三门（deploy / git-write 含 git_merge_mr / host-ops）full_access 不豁免 | src/orchestrator/default-gates.ts:8-9,37-43,50-59,63-66 |
| 门匹配=按 add 顺序首条命中 | src/domain/gate-router.ts:41-49 |
| **force 门+agent 级白名单自动放行**已有先例（hostExecAllowlist 纯函数） | src/domain/host-exec-allowlist.ts:34-47；消费点 src/orchestrator/orchestrator.ts:249 附近 |
| 进化官：评估→设计→实现→MR、不合并不部署、admin-only、whitelist 无 Bash | src/orchestrator/self-improver-agent.ts:9-24,43,51 |
| donger-git = jihulab/github/gitee 三平台 API 抽象（列分支/MR/合并/查流水线） | src/orchestrator/git-platform-tools.ts:12,132,360；latestPipeline gitee 暂不支持 :241-246 |
| 进化官仓库与凭证注入 | src/config.ts:82-84,259,322 |
| 容器化部署：手工 build→改 .env tag→compose up；healthcheck 打 /api/health；DONGER_SLOT_SUFFIX 支持演练槽；migrate --rehearse 全量演练+自动解除武装 | deploy/compose.yaml:10-11,34-41；docs/deploy-docker.md |
| P0 注入四项（只读直通旁路守卫 / 代码执行失明 / env 全量继承 / schtasks 持久化）+ P1 出网全开 | docs/agent-sdk-prompt-injection-probe-20261010.md §2 |
| 限流端口（滑动窗口，feedback 键已有） | src/ports/rate-limiter.ts:6-10,27-29 |
| 反馈状态机 open/accepted/resolved/closed（存储值零迁移） | src/domain/feedback.ts:10-11 |

## 4. 分模块设计

### 4.1 M0 安全前置：P0 注入修复（L2 硬前置，独立可交付）

L2 把注入面从"会话内"放大到"生产变更链"，P0 不修不开闸。按探针报告 §5 裁剪：

**L2 阻塞项（必须全绿）**：
1. **守卫位置迁移**（P0-1/P0-2）：claude 用 PreToolUse hook 接管全部工具调用守卫；zcode 关闭 build 模式"只读直通"——所有 Bash/Read 一律发 requestPermission。守卫判定逻辑（tool-call-guards/matchSensitiveRead）原样复用。
2. **Bash 语义审计**（P0-2）：base64/hex/`\x` 转义/eval 形态一律进审批或拒绝。
3. **env 白名单注入**（P0-3）：两引擎改显式 env allowlist（PATH/HOME/系统必要项+平台注入项），杜绝 `...process.env` 全量展开。
4. **Grep/Glob 纳守卫**（P1-4，报告 §5 项 7）：path 参数过 matchSensitiveRead。
5. **claude 宿主状态隔离**（P1-3 报告项 5）：CLAUDE_CONFIG_DIR 重定向平台管理目录。
6. **出网最小管控**（P1-2 报告项 4 的裁剪版）：unattended 轮内 curl/wget/nc/ssh 形态进审批（curl 命中现有 ssh-egress 同型模式）；不做代理白名单（留 M3）。

**不阻塞 L2（随后补）**：Windows 沙箱 fail-closed（报告项 6）、转录池治理（项 8）、codex 引擎覆盖。

**验收**：`npx tsx scripts/sec-probe.ts claude` 与 `zcode` 全矩阵重跑，P0-1/P0-2/P0-3/P0-4 及出网用例全部被拦（判定源含宿主取证）；`scripts/guard-check.ts` 纯函数回归绿。

### 4.2 提案协议（agent → 平台的确定性交接面）

无人值守 agent 会话的终点不是"合并"，而是**提交提案**：

1. agent 在会话 worktree 内完成：评估 → 实现 → `npm test` + `tsc` + web 构建 全绿 → 建分支（`fix-YYYYMMDD-<slug>`）→ push → `git_create_mr`，MR 描述末尾附机器可读提案块：

   ````markdown
   ```donger-proposal
   {"v":1,"feedbackId":"...","kind":"bugfix","riskNotes":"...","testEvidence":"npm test 1063 绿 / tsc 0 错 / web build ok"}
   ```
   ````

2. 提案块只是**线索不是依据**：ReleaseService 从平台 API 拉取**真实 diff**（文件清单/增删行数/路径）重新实测，agent 声明仅作展示。
3. agent 全程不调用 git_merge_mr（工具白名单里就不配它）；push/建分支/建 MR 走 git-write 门 + 4.4 的放行白名单。

### 4.3 ReleasePolicy 纯函数引擎（爆炸半径白名单）

新文件 `src/domain/release-policy.ts`，纯函数 + 全量单测（判定偏保守：误放行=事故，误拦截=回人工）：

```ts
interface ReleaseProposalInput {
  changedFiles: { path: string; additions: number; deletions: number; isNew: boolean }[];
  totalAdditions: number; totalDeletions: number;
  headSha: string; baseSha: string;      // master 当前 SHA 用于一致性校验
  masterHeadSha: string;
}
interface ReleasePolicy {                // 挂在 workflow.autoDev，admin 可配
  maxFiles: number;                      // 建议 15
  maxChangedLines: number;               // 建议 400
  protectedPaths: RegExp[];              // 硬 deny 清单（见下）
  requireNewTestsOnly: boolean;          // 修改既有测试文件→不自动合并（防测试篡改）
  dailyAutoMergeQuota: number;           // 建议 3（RateLimiter 键 automerge:<date>）
  cooldownOnRollbackHours: number;       // 回滚后该 workflow 冷却（建议 24h）
}
verdict = { allow: boolean; reasons: string[] }   // reasons 逐条可审计
```

**首版 protectedPaths（硬 deny，命中即回人工）**：
- 安全边界与门：`src/orchestrator/default-gates.ts`、`src/domain/gate-router.ts`、`src/orchestrator/approval-flow.ts`、`src/domain/permission-mode.ts`、`src/adapters/web-route-guards.ts`
- 引擎 runner：`src/orchestrator/*agent-runner*.ts`
- 部署与宿主：`deploy/**`、`scripts/docker-*`、`scripts/host-*`、`.env*`、`**/Dockerfile*`
- 凭证与身份：`src/adapters/credential*`、`src/domain/git.ts`（凭证解析）、`migrations/**`
- 依赖：`package.json`、`package-lock.json`（自动链禁止新增/升级依赖）
- 二进制文件一律 deny

**一致性校验**：提交策略评估时要求 `masterHeadSha === baseSha` 严格相等；master 已前进即中止转人工（防并行提案竞态，配合 4.5 发布串行锁）。

### 4.4 git-write 门的策略化放行（push/MR 自动化）

现状缺口：全自动链在 push 处就会弹卡（git-write 门拦 git_push/git_create_branch/git_create_mr）。沿用 hostExecAllowlist 先例，在审批 resolver（orchestrator.ts:249 同一消费位）为 git-write 门增加 **workflow.autoDev 放行白名单**：

- 仅当：运行来源=绑定 autoDev 策略的 workflow、仓库=策略绑定仓库、分支名匹配 `^(feat|fix)-\d{8}-`、非 force push、MR 目标=master 且标题带 `[autofix]` → 自动放行 + 审计打标 `auto_policy:git-write`；
- 其余任何形态（含 git_merge_mr）照旧弹卡——L1 是天然兜底路径。

自动合并本身**不经 agent 工具**：ReleaseService 服务端直调 GitPlatformApi（git-platform-tools.ts:132 同端口）执行 merge，凭据复用 `selfImproveGit`（config.ts:259）解析链，v1 复用现有凭证 + MR 标注，v2 换专用 release-bot（D2）。

### 4.5 ReleaseService（平台内确定性编排）

新组件 `src/orchestrator/release-service.ts`（与 EventDispatcher 同型，无 LLM）：

```
提案接收（轮询 MR or agent 侧新平台工具 submit_proposal，见 D3）
  → 拉 diff → ReleasePolicy.eval
    ├─ deny   → release_runs 记 rejected + 通知管理员（MR 链接+原因），转人工（=L1）
    └─ allow  → 发布锁获取（串行）→ master 一致性校验 → 平台 API merge
              → release_runs 记 merged → 通知"已合并，待发布"
              → （宿主管线异步接管，见 4.6）
结果回收（4.7 hook）→ deployed / rolled_back 状态回写 + 反馈状态机推进 + 通知
```

新表 `release_runs`：id / workflowRunId / feedbackId / mrUrl / headSha / baseSha / policyVerdict(JSON) / status(`rejected|merged|deployed|rolled_back|needs_human`) / createdAt / updatedAt。执行记录永久保留（对齐触发记录 D5 口径）。

### 4.6 宿主发布管线（watcher + host-release 脚本）

新增宿主侧组件（仓库内 `scripts/`，运行在宿主 Git Bash，经 schtasks 每 2-5 分钟轮询）：

- **watcher**：对本机 donger 仓库克隆 `git fetch`，master SHA ≠ 上次发布标记文件 → 触发 `host-release.ps1 <newSha>`；单实例锁（发布串行）。
- **host-release.ps1 五步**：
  1. **备份**：调既有 `scripts/docker-backup.sh`；
  2. **构建**：`docker build -f deploy/Dockerfile -t donger:auto-<sha8>-<ts> .`（MSYS_NO_PATHCONV 铁律沿用）；
  3. **演练**：复用 `docker-migrate.sh --rehearse --image <tag>`（3331 槽，**自动解除武装**——停工作流+作废在途通知，天然防递归发布）+ 冒烟脚本（/api/health 200、web bundle 200、DB 可开）；
  4. **切换**：演练槽冒烟绿 → 改栈目录 `.env` 的 DONGER_IMAGE_TAG → `docker compose up -d`；
  5. **健康观察与自动回滚**：start_period 90s 后连续探测 /api/health（compose healthcheck 同口径），超时或 unhealthy → **改回上一 tag + up -d**（上一 tag 镜像本机常驻）→ 记 rollback。
- 全程追加宿主侧发布日志文件；无论成败，结束后 `POST https://<生产域名>/api/internal/release-result`（带随机 token，见 4.7）。
- **watcher 的安全性**：零新增容器特权（不挂 docker.sock）、零入站面（只出站 fetch+POST）、回滚自主（不依赖 donger 存活）；它信任的只有 git 历史与自己本机的状态文件。

### 4.7 结果闭环（反馈状态机 + 通知）

- 新内部路由 `POST /api/internal/release-result`：首启生成随机 token 存 app_config，校验后交 ReleaseService 回收结果。**必须登记 web-route-guards**（新路由不登记=404，既有铁律）；token 走请求头不进 query。
- 状态推进（存储枚举零迁移，语义映射）：
  - 自动合并成功 → 反馈 `accepted`（若尚为 open）+ 通知提交人"已修复，待发布"；
  - 部署成功 → 反馈 `resolved` + 通知提交人"已发布 vX.Y（<sha8>）"+ 通知管理员；
  - 回滚 → 反馈回 `accepted` + release_runs 记 `rolled_back` + **高优通知管理员**（站内信+钉钉卡片）+ workflow 进入冷却；
  - 策略拒绝 → 通知管理员人工处理（含 MR 链接与拒绝原因逐条）。
- 递归防线：release-result 端点**不产生** feedback.created；演练槽解除武装（现成）；每日配额（RateLimiter `automerge:<workflowId>:<date>`）；全局 kill-switch `DONGER_AUTODEV_DISABLED=1`（读端+读守卫层短路，重启生效）。

### 4.8 泛化：产线项目接入（v1 只留抽象位）

`ReleaseChannel` 端口：`{ trigger(release): Promise<void>; onResult(cb): void }`。v1 唯一实现 = HostWatcherChannel（4.6）；预留 JenkinsChannel / WebhookChannel 位。产线项目接入路径：call 事件（`/hooks/<random>`，src/domain/event.ts:25）回灌工单 → 同一 workflow/policy 机制 → 自定义 channel。**不为本轮实现**。

## 5. 配置面与数据模型

- `Workflow` 扩列 `autoDev?: { enabled: boolean; policy: ReleasePolicy; credentialCode?: string }`（扩列迁移收尾核对列清单——workflow-triggerid 轮铁律）；v1 内嵌 workflow 字段，v2 独立策略资产可被多 workflow 共享。
- 执行体 agent：不改内置进化官语义，**模板化派生**——以进化官 prompt 为底稿的新 agent 模板（工具白名单加 Bash/Edit/Write，读写边界天然 confine 在会话 worktree；不含 git_merge_mr、不含 donger-host），管理员创建 workflow 时一键从模板生成（D8）。
- 进化官 system prompt 微调：增加提案块协议说明与"提交提案后即止，合并与部署由平台策略执行"（原红线保持）。
- 审计：release_runs 独立 tab（工作流详情页）+ 审计页打标 `auto_policy` 过滤器。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 测试篡改（agent 改测试让其恒过） | 策略规则：修改既有测试文件→不自动合并；新增测试文件放行；演练冒烟做行为级校验 |
| 并行提案竞态（两个提案同时过审） | 发布串行锁 + master 一致性校验，baseSha 漂移即中止回人工 |
| 坏发布引发事故 | 演练槽前置 + 切换后健康观察 + 自动回滚（不依赖 donger 存活）+ 切换前自动备份 + 每日配额 + 回滚冷却 |
| 提示注入借道反馈进变更链 | M0 硬前置 + wrapUntrusted（已有）+ 策略只信 diff 不信声明 + protectedPaths 兜底 |
| watcher 单点/停摆 | schtasks 幂等重入、发布日志落盘、watcher 停摆=不发布（fail-safe 方向正确：少发布不误发布）；告警=release-result 超时未回收通知管理员 |
| 自动合并凭据滥用 | v1 复用现有凭证但服务端专用调用路径（agent 工具面无 merge）；v2 release-bot 专号（D2） |

## 7. 实施拆分

- **M0 安全前置**（§4.1，独立可交付）：守卫位置迁移 + Bash 语义审计 + env 白名单 + Grep/Glob 守卫 + claude 配置隔离 + 出网最小管控。验收=sec-probe 双引擎 P0 矩阵全绿。
- **M1 提案与自动合并**（§4.2-4.4、4.5、§5）：proposal 协议 + release-policy 纯函数 + git-write 放行白名单 + ReleaseService + release_runs + 通知。上线即达成"反馈→合并全自动，部署仍手工"（等效 L1.5）。
- **M2 宿主管线与闭环**（§4.6-4.7）：watcher + host-release.ps1 五步 + 内部结果端点 + 反馈状态推进 + kill-switch。达成 L2 全闭环（donger 自身）。
- **M3 治理与泛化**：审计 UI、ReleaseChannel 抽象与产线项目开通、出网代理白名单、自动 revert MR、release-bot 专号。

依赖关系：M1 依赖 M0（安全闸门验收）；M2 依赖 M1；M3 独立增量。每个 M 结束都是可运行形态。

## 8. 决策点（待拍板，含推荐）

- **D1 部署触发通道**：宿主 watcher 轮询（**推荐**：回滚不依赖 donger、零新增容器特权、零入站面）vs 容器内 ReleaseService 经 ssh 直驱宿主脚本（时延秒级，但需宿主 sshd+容器持宿主凭证）vs CI 管道（jihulab runner 装宿主，重）。
- **D2 合并身份**：v1 复用 selfImproveGit 凭证+MR 标注（**推荐**）vs 立即建 release-bot 专号（审计更干净，多一步账号管理）。
- **D3 提案提交通道**：ReleaseService 轮询平台 MR 列表（零新工具，2min 时延，**推荐 v1**）vs agent 调新平台工具 submit_proposal 即时提交（需新增平台 MCP 工具）。
- **D4 反馈状态映射**：merged→accepted、deployed→resolved、rolled_back→accepted+冷却（**推荐**，存储枚举零迁移）。
- **D5 策略首版数值**：≤15 文件 / ≤400 行 / 日 3 单 / 回滚冷却 24h / protectedPaths 见 §4.3（**推荐值**，上线后按审计调参）。
- **D6 演练形态**：复用 migrate --rehearse 全量拷贝（重、分钟级、真实——**推荐 v1**）vs 轻量只读槽（快但假数据，递归风险需另防）。
- **D7 P0 修复范围**：§4.1 六项为 L2 硬前置，沙箱 fail-closed/转录池治理不阻塞（**推荐**）；若拍板全量修复，M0 工期约 +50%。
- **D8 autoDev 执行体**：模板化派生 agent（**推荐**，内置进化官语义冻结）vs 直接放宽进化官工具白名单。

## 9. 验收样板（场景只当验收）

1. **绿路**：用户提交 logic 类反馈"导出缺字段"→ 全自动链路：分诊→修复→测试绿→MR→策略命中→自动合并→宿主构建→演练绿→生产切换→health 绿→反馈 resolved→提交人收到"已发布"回复。全程无人工点击。
2. **红线**：某提案 diff 触碰 `default-gates.ts` → 策略 deny（reasons 列出命中路径）→ release_runs 记 rejected → 管理员收到通知，人工走 L1 审批卡决定。
3. **坏发布**：某合并后的镜像启动即 crash → 演练槽冒烟应已拦；若漏网（演练绿生产挂）→ 切换后健康观察失败 → 自动回滚上一 tag → 管理员高优通知 + workflow 冷却 24h + 反馈回 accepted。
