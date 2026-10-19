# 热发布设计方案：优雅排水 → 顺序换槽 → 断流自愈 + 审批决议落库

- 日期：2026-10-16
- 状态：待拍板（未动码）
- 前置轮：2026-10-16 热发布调研轮（对话中断根因与方案选型已确认：不做进程内热替换，复刻 K8s rolling 语义到单机 compose）
- 用户点名需求：**审批决策落库**（跨重启存活、可续跑）

---

## 0. 目标与非目标

**目标**
1. 发布新版时，进行中的 agent 轮不被打断，自然完成后进程才退出（排水）。
2. 排水超时或进程崩溃被杀的轮，新实例启动后**自动续跑**（复用 resume 指针），用户感知为"停顿几十秒后继续"。
3. 挂起中的审批**跨重启存活**：决议落库、重启后卡片可点、点批准后任务从断点继续。
4. 发布脚本固化：build → 换槽 → 健康等待 → 可回滚，一条命令。
5. 断线重连后前端增量不丢（补拉 / SSE 重放）。

**非目标**
- 进程内热替换代码（Node cluster/pm2 reload）：better-sqlite3 原生模块 + agent 子进程 + 单写者 SQLite，语义不成立。
- 双实例并行蓝绿：6+ 常驻循环（scheduler/eventDispatcher 泵/worktree GC/记忆整理/审计刷盘/漂移检测）无跨进程去重，单实例性完全押在 `donger.lock`（`src/util/single-instance.ts`）。只做**顺序交接**。
- 前置反代（Caddy/Nginx）：可后手，本期不做（§11 D5）。

---

## 1. 现状基线（实施必读的锚点）

| # | 事实 | 锚点 |
|---|------|------|
| F1 | SIGTERM 停机序列：停 GC→scheduler.stopAll→audit flush(1s race)→webChannel.stop(500ms race)→exit(0)，**全程约 1.5s 强退** | `src/index.ts:777-788` |
| F2 | `webChannel.stop()` 只调 `server.close()`，无 closeAllConnections、无连接清点，SSE 卡住 close 靠 race 硬退 | `src/adapters/web-channel.ts:8250-8254` |
| F3 | SSE 事件无 `id:` 字段，无 Last-Event-ID；30s 心跳；`sseClients: Map<convId, Set<client>>` | `web-channel.ts:1502-1537, 664` |
| F4 | 前端 onopen 只重查挂起审批，**不补拉断线期间的消息/事件** | `web/src/lib/webChat.ts:314-319` |
| F5 | 审批 resolver 是纯内存 Promise：`pendingApprovalResolves: Map<approvalId, {…, resolve}>`，approvalId 为 web 层随机 uuid；**不设超时** | `web-channel.ts:944-982, 1016, 966-967` |
| F6 | 决议回灌引擎：claude 走 canUseTool 返回、zcode 走反向请求响应（控制协议原地继续）；codex 无审批通道（`approval_policy:"never"` 静态拒绝） | `claude-agent-runner.ts:249-263`、`zcode-agent-runner.ts:625-666`、`codex-agent-runner.ts:114, 194-202` |
| F7 | **决议本身零落库**：无审批审计事件、无审批表；只有请求侧站内信（approval.requested）、带评论落 task_comments、adopt 落策略表 | `approval-flow.ts:53-71`、`orchestrator.ts:991-1045` |
| F8 | 重启清扫：running→failed、awaiting_approval→failed（审批随进程丢失）、awaiting_credentials 不动；zcode 被杀轮从 `.zcode-home` 补录 | `src/orchestrator/restart-sweep.ts:32-99`，调用点 `src/index.ts:809-818` |
| F9 | **failed 是终态且 updateStatus 幂等锁死**——被清扫的任务不可能复活，续跑必须绕开或复用原行 | `sqlite-task-store.ts:41-42` |
| F10 | resume 链路三引擎已统一（RunOptions.resume），sdkSessionId 双保险（session_init 即时 commit + transcript 反查），session 过期有 clearResume 兜底 | `runtime-manager.ts:429-440, 696-711`、`orchestrator.ts:1090-1103, 1170-1207` |
| F11 | 活跃轮登记全在内存：`userActiveTasks` / `abortControllers` / `pendingQueues`（排队消息也是内存，退出即丢） | `orchestrator.ts:278-295, 1790-1811` |
| F12 | 事件队列已有"重启重投"范式：restore 把遗留 running→queued 重投 at-least-once，泵按行级 claim 认领 | `event-dispatcher.ts:138-157, 294-301` |
| F13 | compose：单服务、`stop_grace_period: 120s`、容器内进程 HTTPS、healthcheck https+跳自签、槽位变量 `DONGER_SLOT_SUFFIX` 已预留、数据已迁 named volume（donger-db/donger-data） | `deploy/compose.yaml:4-46`、生产栈 `D:\deploy\donger-docker\compose.yaml` |
| F14 | 栈目录守护脚本 `donger-health-monitor.ps1` 为**纯观察**（只写日志，不拉起容器）——排水期无干扰 | `D:\deploy\donger-docker\donger-health-monitor.ps1` |
| F15 | 每日 03:30 备份走 `docker exec donger-app`（容器名存在性依赖）；CI 只 lint/test/build 不产镜像，发布=本机 build+compose | `db-backup.ps1`、`.github/workflows/ci.yml` |

---

## 2. 总体架构

```
发布：build 新镜像（线上无感）
  └─ docker compose up -d（recreate 天然顺序交接）
       └─ SIGTERM → 旧实例进入排水（M1）
            ├─ 停新作业：scheduler.stopAll / eventDispatcher.pause / 拒新消息(503)
            ├─ SSE 广播 server_draining（前端进"发布中"态）
            ├─ 等活跃轮自然完成（≤ 排水上限）
            ├─ 超时未完轮 → 标 interrupted（M2 状态扩展）
            └─ audit flush → server.close+closeAllConnections → exit(0)
       └─ 新实例启动
            ├─ sweep：孤儿 running→interrupted；awaiting_approval→重臂不杀（M3）
            ├─ resume-service 自动续跑 interrupted（M2）
            └─ /api/health 200 → compose 健康通过
       └─ 浏览器 EventSource 自动重连 → onopen 补拉（M4a）
横切：审批决议落库（M3）——请求即落库、决议事务落库、重启重臂、决议驱动续跑
```

发布真空窗 = 新容器启动到 listen，约 5~15s。期间：存量对话已在排水期完成（零中断）；新请求 503+Retry-After 由前端自动重试；SSE 由浏览器自动重连。

---

## 3. M1 优雅排水（P0，收益最大）

### 3.1 新模块 `src/orchestrator/drain-manager.ts`

```ts
interface DrainManager {
  readonly state: "normal" | "draining";
  readonly deadline: number | undefined;
  beginDrain(opts: { timeoutMs: number; reason: string }): Promise<void>; // resolve=可安全退出
  activeTurnCount(): number;      // 扁平化 userActiveTasks（orchestrator.ts:280 注入）
  shouldRejectNewTurn(): boolean;
}
```

- `beginDrain` 内部流程：置 draining → 停常驻循环 → 退回排队消息 → 广播 draining → 轮询等 `activeTurnCount()===0` 或超时 → 超时则回调 `onTimeout(activeTasks)`（index.ts 里做 markInterrupted）→ resolve。
- orchestrator 提供 `flushPendingQueues(reason)`：drain 开始时对 `pendingQueues`（内存队列，F11）逐条退回——推送一条会话提示（"服务更新中，该消息未执行，请稍后重发"）+ messageStore 落档，防止静默丢失。

### 3.2 停机序列重写（`src/index.ts:777-788`）

```
SIGTERM/SIGINT
 1. stopWorktreeGc() / 停 memoryConsolidator
 2. scheduler.stopAll()                    // 从关停阶段提前到排水起点
 3. eventDispatcher.pause()                // 新方法：泵停认领，queued 行留库，下实例 restore 重投（F12 语义复用）
 4. drainManager.beginDrain(...)           // 含超时 markInterrupted
 5. auditStore.flush()（1s race，保持现状）
 6. webChannel.stop() 增强：
    - 广播终态 {type:"server_stop"}（可选）
    - server.close() + server.closeAllConnections()   // Node≥18.2，杀 keep-alive/SSE 残留
 7. process.exit(0)
```

排水期间 `/api/health` **恒 200**（body 增 `draining:true, activeTurns, deadline`）——compose healthcheck 与 health-monitor（F14 纯观察）都不受扰。

### 3.3 新作业拒入矩阵

| 入口 | 排水期行为 |
|------|-----------|
| `POST /api/conversations/:id/messages`（web-channel.ts:1319） | 503 + `Retry-After: 5` + `{error, draining:true}` |
| orchestrator.handleMessage（其他渠道兜底） | draining 时拒绝；dingtalk 回文本"服务更新中，请稍后重发"；callbackSubmit 同 |
| 排水前已在 pendingQueues 的消息 | flushPendingQueues 退回（3.1） |
| 创建会话 / cancel / approvals respond / pending-approval / SSE connect | **放行** |
| webhook `/hooks`、cron、workflow manualRun | scheduler 已停 + 泵已 pause → 入队不执行，重启后续投 |

前端（webChat.ts send, :506-555）：收到 `draining:true` 503 → 用户消息保持"发送中"态 + toast"服务发布中，Ns 后自动重试" → 按 Retry-After 自动重发（上限 3 次）。chatReducer 的 `message_delivery` 增 `deferred` 态。

### 3.4 SSE draining 事件

排水开始时 `broadcastToConversation({type:"server_draining", deadline, reason})`（写点：web-channel.ts:1165）；事件类型登记 web-channel.ts:392 起。前端 toast："服务正在更新，当前对话会继续完成后切换，预计 Ns"。

### 3.5 compose 改动

```yaml
stop_grace_period: ${DONGER_STOP_GRACE:-660s}   # 必须 > DONGER_DRAIN_TIMEOUT_MS + 60s
```

- `DONGER_DRAIN_TIMEOUT_MS`（默认 600000）进 `donger.env`；`DONGER_STOP_GRACE` 进栈 `.env`。
- 超时兜底层级：排水超时（应用自行 markInterrupted+有序退出）→ stop_grace_period（docker SIGKILL，纯兜底）。**铁律：grace > drain + 60s**，否则排水被拦腰砍断、markInterrupted 来不及执行。

---

## 4. M1.5 发布脚本 `scripts/docker-release.sh`

compose recreate 对同名 `container_name` 天然"先停旧后建新"，脚本因此很薄：

```
用法：scripts/docker-release.sh --image donger:TAG [--stack /d/deploy/donger-docker]
步骤：
 1. 前置检查：当前容器 health 200（否则中止，避免在故障态上发布）
 2. docker build -t donger:TAG .            # 线上无感
 3. 写栈 .env 的 DONGER_IMAGE_TAG=TAG
 4. (cd 栈目录 && docker compose up -d)      # 触发 SIGTERM 排水，recreate 顺序交接
 5. 排水观察：docker logs -f donger-app，打印 "[drain]" 行直到退出
 6. 健康等待：/api/health 200（最长 150s，复用 migrate 脚本的轮询写法）
 7. 失败回滚：.env 写回上一 TAG + compose up -d + 健康等待；成功则清理旧镜像（保留最近 2 个）
```

- 沿用 `export MSYS_NO_PATHCONV=1` 铁律（migrate 脚本 L11-12 实锤）。
- Runbook 附注：避开 03:25-03:40 发布（db-backup.ps1 依赖 `docker exec donger-app`，窗口内会当日失败，无数据风险）；发布后瞄一眼 `logs/donger-health.log` 的 FREEZE/RECOVER 行留档。
- 回滚语义 = tag 指回旧镜像重跑同脚本；数据卷不动，DB schema 迁移须保持向后兼容一版（本项目 DDL 全部幂等，现状已满足）。

---

## 5. M2 中断轮自动续跑

### 5.1 任务状态机扩展（`src/domain/task-state-machine.ts` + `types.ts:19`）

```ts
TaskStatus 增加 "interrupted"          // 非终态
TaskEvent  增加 "interrupt"
TRANSITIONS 增加：
  running:      { interrupt: "interrupted", … }
  interrupted:  { resume: "running", fail: "failed", cancel: "canceled" }
```

- `status` 是 TEXT 列（sqlite-task-store.ts:15），**零 DDL**；终态仍是 done/failed/canceled。
- 消费方核对清单（实施时逐个过）：执行列表状态分组、淘汰排序 pendingSince、`listByStatus` 调用点、任务页徽标（"已中断·恢复中"）。

### 5.2 标记时机（两处）

- **排水路径**（进程还活着）：drain 超时 → 对剩余 running 调 `updateStatus(taskId,"interrupt")`——此刻标记最精确。
- **崩溃路径**（进程没机会标记）：启动 sweep（restart-sweep.ts:32-99）把孤儿 `running` 从"标 failed"改为"标 interrupted"；awaiting_approval 的处理移交 M3（不再标 failed）。
- zcode 补录（restart-sweep.ts:47-75）保持原位：**先对账、后续跑**，顺序固定。补录窗口沿用 `task.createdAt`，续跑轮复用同一 taskId，`zcode_reconcile` 幂等标记按 taskId 记——续跑发生在窗口之后，不会误跳也不会重放（对账器幂等语义与续跑天然兼容）。

### 5.3 新模块 `src/orchestrator/resume-service.ts`

```
resumeInterruptedTurn(task, syntheticText):
  1. 会话存在性/非 busy 校验（启动后无人占用，恒过；防御式保留）
  2. updateStatus(taskId, "resume") → running；注册 userActiveTasks/abortControllers（复用 runExclusive 的登记原语）
  3. 合成轮输入："[系统恢复] 服务更新重启，上一任务在执行中被中断。请根据已有进展继续完成任务，不要重复已完成的步骤。"
     （agent SDK resume 指针使其能看到中断前的全部会话上下文——F10 双保险已保证指针在）
  4. 调 runTurn（带 resume；不 noResume）→ 正常走完状态收尾（done/failed）
```

- **排除面（防双跑）**：workflow 运行会话已被 eventDispatcher.restore 的 at-least-once 重投覆盖（F12），resume-service 必须跳过——实施时核对运行会话的标记字段（dispatcher 建会话走 createWithAgent 独立路径，event-dispatcher.ts:170-193），以会话元数据判定。
- **渠道范围 v1**：仅 `channelId==="web"` 的会话自动续跑；dingtalk/CLI 轮维持现状（标 failed+提示）——钉钉续跑回复需要 thread 路由，另立轮次（§11 D7）。
- 熔断：单次启动续跑上限 5 个，按 updatedAt 新者优先；续跑轮失败即 failed，不二次重试。
- 开关 `DONGER_AUTO_RESUME`（默认 1）；关掉时 interrupted 轮维持状态、前端给"继续/放弃"按钮（走同一 resume-service）。

---

## 6. M3 审批决议落库（用户点名，本期核心）

### 6.1 数据模型（新表，幂等建表）

```sql
CREATE TABLE IF NOT EXISTS approval_requests (
  id            TEXT PRIMARY KEY,      -- = approvalId（生成点从 WebChannel 上移，见 6.2）
  task_id       TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  gate_id       TEXT NOT NULL,
  tool          TEXT,
  title         TEXT NOT NULL,         -- ApprovalCard.title
  summary       TEXT,                  -- ApprovalCard.summary
  payload       TEXT,                  -- JSON：ApprovalRequest 全量（input/toolUseId/adoptDraft…）
  channel       TEXT NOT NULL DEFAULT 'web',
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending|approved|rejected|expired|canceled
  decision      TEXT,                  -- JSON：{approved, reason, comment, responderId, adoptPrefix}
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(task_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
```

- 新增 `src/ports/approval-store.ts` + `src/adapters/sqlite-approval-store.ts`（项目既有 port/store 模式）。
- 迁移仅新表、幂等建表，无扩列——不触碰"扩列迁移收尾核对列清单"雷区。

### 6.2 写入时机

**请求侧（关键设计：请求即落库，进程随时可死）**
- `makeApprovalResolver`（approval-flow.ts:18-82）置 awaiting_approval 的同一时机（:44-50）写 `approval_requests(status=pending)`，payload 含卡片全量字段（title/summary/adoptDraft 在 approval-flow.ts:35-42 已构造）。
- `approvalId` 的 uuid 生成从 `WebChannel.requestApproval`（web-channel.ts:950）上移到 approval-flow，随卡片传入——**DB row id == approvalId**，web 层不再自造键。WebChannel.requestApproval 改为登记 `{approvalId → resolve}`（Map 仍存活，正常路径零变化）。

**决议侧（DB 先行，内存后行）**
- `handleApprovalRespond`（web-channel.ts:1549-1614）改为：
  1. `approvalStore.decide(id, decision)`：单条 UPDATE `SET status=:s, decision=…, decided_at=… WHERE id=? AND status='pending'`——`changes===0` 即他端已决议 → 409 幂等返回（天然防双击/双端竞态）；
  2. 成功后 `pendingApprovalResolves.get(id)?.resolve(decision)`（进程内轮原地继续，F6 路径不变）；
  3. 广播 `approval_closed`。
- 决议审计：每条决议落一条 `approval_decision` 审计事件（audit_events）——现状批/拒完全无痕（F7）。
- 决议通知：新增 `approval.decided` 站内信（现在只有 requested，src/domain/notification.ts:20）。

### 6.3 查询侧（前端恢复锚定）

- `getPendingApproval`（web-channel.ts:1038-1057，前端 onopen/切会话都调它）改为**内存优先、miss 查 DB**：进程内活审批走原路径；重启后从 DB pending 行合成同形 DTO 返回。前端 `refreshPendingApproval`/404 换绑逻辑（webChat.ts:129-144, 592-602）零改动即获得"重启后残卡重新锚定"。

### 6.4 跨重启决议 → 续跑

进程死了，原轮的引擎子进程随之死亡，审批的 resolver 永远不可能等回原轮——所以**重启后的批准不是"放行原轮"，而是"决议落库 + 触发续跑"**：

```
用户点（重臂后的）卡片批准/驳回
  → handleApprovalRespond：DB 决议落库（6.2）
  → 内存无 resolver（Map 空）→ 走 resumeAfterApproval 分支：
      resume-service.resumeInterruptedTurn(task, 合成输入)
      合成输入："[审批决议] 你此前在「{title}」处请求审批（{summary}），用户已{批准/驳回}（理由：{reason}）。
                批准含义：该操作允许执行，请继续；驳回含义：该操作不得执行，请调整方案或说明受阻。"
```

- 任务行语义：**复用原 task**（awaiting_approval --resume--> running，状态机既有转换，task-state-machine.ts:31-36），保持"一个任务一条生命周期"，审计/通知的 taskId 连续。备选方案（新 task + 旧 task 置 canceled）见 §11 D3。
- adopt（通过并记住）：重臂路径把 orchestrator.ts:991-1045 的 adoptPrefix→策略落库逻辑抽成公共函数复用，避免分叉。
- **会话忙冲突**：决议到达时该会话已有新任务在跑（用户重启后重新发过消息）→ 返回 409"该会话已有新任务在执行，旧审批不再续跑"；行保持 pending，用户可从执行列表取消旧任务（联动既有 cancelPendingApprovals 语义，行→canceled）。
- **范围**：codex 无审批通道（F6），天然无关；钉钉决议同样落库（channel 列区分），跨重启续跑仅 web（同 M2 范围）。

### 6.5 与排水/清扫的关系

- 排水期审批卡可点、resolver 活着 → 走正常决议路径（原地继续），排水对审批零感知；**awaiting_approval 轮不阻塞排水**（可能挂几小时，排水上限照常生效，超时后由本节的跨重启路径接管）。
- 启动 sweep：`awaiting_approval` 且 approval_requests 有 pending 行 → 保留状态 + 重臂（不标 failed）；无行（理论不可能，防御）→ 维持现状标 failed。

---

## 7. M4 流自愈

### 7.1 P2a 重连补拉（必做，改动最小、体感收益最大）

- webChat `onopen`（webChat.ts:314-319）在 refreshPendingApproval 之外，补一次与 switchConversation 相同的 `messages + events?light=1` backfill（复用 :376-392 的并发请求与 assembleTurnMessages 重建）。
- 服务端零改动。消除"重连成功但断线期间的增量永久丢失"这一最大体感缺口。

### 7.2 P2b SSE id + Last-Event-ID 选择性重放（升级项）

- 服务端：`broadcastToConversation` 为每事件分配 per-会话单调 `seq`；`SSEClient.write`（web-channel.ts:1502-1505）输出 `id: ${seq}` 行；每会话内存环形缓冲（默认 500 条 / 15 分钟 TTL）。
- 重连握手带 `Last-Event-ID`（浏览器 EventSource 原生自动携带）→ 重放 seq 之后的事件，首尾包 `replay_start {from}` / `replay_end`；缓冲已截断 → 发 `{type:"resync"}`，客户端全量重建。
- 客户端：收到 replay_start 先用 history 重建该轮瞬态 delta（文字流以 history 为准），随后续 live；卡类/结构化事件（approval_card/ask_user_question/result）由重放保证零丢失。
- 价值分级：P2a 解决"丢内容"，P2b 解决"丢卡/重复/闪烁"。P2b 可独立后置（§11 D4）。

### 7.3 PWA 版本自动刷新

- `PwaUpdatePrompt`（registerType:"prompt" 现需手点）：SSE 重连且检测到新版本时自动 `updateServiceWorker(true)`，toast 告知已刷新。避免发布后用户停留旧 bundle（附件轮实锤过的坑）。

---

## 8. 变更清单汇总

**数据模型**：+`approval_requests` 表（幂等建表）；`tasks.status` 增 `interrupted` 值（零 DDL）。无扩列迁移。

**新模块**：`drain-manager.ts`、`resume-service.ts`、`ports/approval-store.ts`、`sqlite-approval-store.ts`。

**改动点（file:line）**：index.ts:777-818（停机序列+sweep 参数）；web-channel.ts:944-1057/1502-1537/1319/1549-1614（审批落库、SSE id、503、respond）；approval-flow.ts:18-82（请求落库+id 上移）；orchestrator.ts:278-295/1790-1811（registry 暴露+排队退回）；restart-sweep.ts:32-99（interrupted+重臂）；task-state-machine.ts/types.ts（状态扩展）；event-dispatcher.ts（pause 方法）；deploy/compose.yaml + docker-release.sh；webChat.ts/chatReducer/PwaUpdatePrompt（503 重试、draining toast、补拉、自动刷新）。

**配置**：`DONGER_DRAIN_TIMEOUT_MS`（600000）、`DONGER_AUTO_RESUME`（1）、`DONGER_SSE_REPLAY_MAX`（500）、compose `DONGER_STOP_GRACE`（660s）。

---

## 9. 决策点（待拍板）

| # | 决策 | 建议 |
|---|------|------|
| D1 | 排水上限默认值 | 10 分钟（stop_grace=660s）。更长任务靠 M2 自动续跑兜底 |
| D2 | 中断轮续跑模式 | 自动续跑+会话内系统提示（被中断的任务本已获授权，悬着比自动继续更危险）；关开关则退化为前端"继续/放弃"按钮 |
| D3 | 跨重启审批续跑的任务行语义 | 复用原 task（生命周期连续）；备选=新 task+旧 task 置 canceled |
| D4 | P2b（SSE 重放）是否本期做 | 建议 P2a 必做、P2b 本期做精简版（id+重放+resync，不做跨实例持久缓冲）；赶时间可独立后置 |
| D5 | 前置反代（Caddy） | 本期不做：收益仅"发布窗口友好页"，需迁证书+改 healthcheck，纯基建改动 |
| D6 | 决议审计+决议通知 | 都加（approval_decision 审计 + approval.decided 站内信）——补齐审批合规留痕 |
| D7 | dingtalk/CLI 轮的续跑范围 | v1 仅 web；钉钉续跑需 thread 路由设计，另立轮次 |

## 10. 验收用例（发布演练）

1. **排水零中断**：造一个 5 分钟 agent 轮 → 发布 → 轮自然完成、SSE 全程有事件、前端仅出现"发布中"toast。
2. **新作业拒入**：排水期发消息 → 503 → 前端自动重试 → 新实例接起执行。
3. **排队退回**：busy 会话排队中遇排水 → 消息退回且有提示，不静默丢。
4. **排水超时续跑**：造 15 分钟轮（超 10min 上限）→ 发布 → 旧实例标 interrupted 有序退出 → 新实例自动续跑完成，会话内可见系统恢复提示。
5. **崩溃续跑**：`docker kill`（SIGKILL，无排水）→ 新实例启动 sweep → interrupted → 自动续跑。
6. **审批跨重启**：造 awaiting_approval → 发布 → 新实例起来后卡片仍在（重锚定）→ 点批准 → 决议落库 + 任务从断点续跑完成 → 审批页/审计可见决议记录。
7. **审批幂等**：同卡双击/双端 → 第二次 409，决议唯一。
8. **审批 vs 忙会话**：重启后先发新任务再点旧卡 → 409 提示，旧行 pending，取消旧任务后行变 canceled。
9. **断流补拉**：发布窗口内前端 EventSource 重连 → 历史完整，无"断线期增量丢失"。
10. **workflow 不双跑**：触发器轮被排水杀 → 仅 eventDispatcher.restore 重投一次，resume-service 跳过。
11. **回滚**：新镜像健康失败 → 脚本自动回滚旧 tag → 健康恢复。
12. **锁冒烟**：容器 recreate 后新实例正常获取单实例锁（§11 R1 验证项）。

## 11. 风险与坑

- **R1 单实例锁跨容器重建**：锁文件在 named volume 里持久存活，锁记 pid；容器内 node 常为 PID 1，新容器探活可能自指误判。现有发布多次成功说明现状可行，但本方案把重启频率提高数倍——**实施首日先做用例 12 的锁冒烟**；缓解：锁记录加容器 hostname（container id），不匹配即接管（single-instance.ts 小改）。
- **R2 grace 与 drain 的层级**：`stop_grace_period` 必须 > 排水超时 +60s（compose L11 现为 120s，必须改），否则 docker SIGKILL 拦腰砍断 markInterrupted。
- **R3 interrupted 的消费方**：新状态值会影响列表分组/淘汰排序/执行列表派生等所有 status 消费点，实施时逐点核对（§5.1 清单）。
- **R4 getPendingApproval 双源**：内存优先+DB 兜底，字段必须同形（respondId=row id）；遗漏 DB 源会让"重启后残卡"仍显示为失效。
- **R5 续跑的重复劳动**：resume 后 LLM 看得到中断前全部上下文（F10），但可能重做已完成的步骤——合成提示词已明确"不要重复已完成步骤"；zcode 对账先于续跑，记录不丢。
- **R6 workflow 双跑**：eventDispatcher.restore 重投与 resume-service 的排除面必须互斥（§5.3），验收用例 10 专门覆盖。
- **R7 排水期 SSE 半开**：旧实例排水最长 10 分钟，期间浏览器连着旧实例；进程退出时 closeAllConnections 掐断 → 浏览器自动重连到新实例（数秒真空窗，EventSource 原生兜底）。
- **R8 备份窗口**：03:30 db-backup 依赖 `docker exec donger-app`，发布窗口避开或接受当日备份失败（无数据风险，volume 不动）。
- **R9 钉钉长连接**：DWClient 断线自愈，与发布无关；但钉钉排水期入站消息靠文本回复拒入（§3.3），注意文案。

## 12. 分期与工作量

| 期 | 内容 | 估时 | 依赖 |
|----|------|------|------|
| M1 | 排水（3.x）+ 前端 503 重试/draining toast | 1d | — |
| M1.5 | docker-release.sh + runbook | 0.5d | M1 |
| M2 | interrupted 状态 + resume-service + 自动续跑 | 1d | M1 |
| M3 | 审批落库全链路（6.x，含重臂/续跑/幂等/审计/通知） | 1.5~2d | M2（复用 resume-service） |
| M4 | P2a 补拉 + P2b 重放 + PWA 自动刷新 | 1~1.5d | 独立，可穿插 |

总计约 5~6 天。M1+M1.5 落地即可消除"发布打断对话"主诉；M3 落地兑现"审批决策落库"点名需求；M2/M4 是极端场景与体感兜底。
