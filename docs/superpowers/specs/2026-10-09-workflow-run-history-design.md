# 工作流执行记录：查看与显示方案设计

- 日期：2026-10-09
- 状态：待拍板（未动码）
- 关联：docs/superpowers/specs/2026-09-28-event-trigger-feedback-design.md（队列语义）、工作流四缺口（2026-10-08 梳理：stopped 死枚举 / TaskStore 无过滤分页 / task 不回写 loopRunId / 多步编排缺位）

## 0. 现状对码（为什么「加执行记录」不是建新表）

数据层**已有两层执行真源**，缺的不是存储，是关联、查询面和展示：

| 层 | 载体 | 已有 | 缺口 |
|---|---|---|---|
| 交付层 | `trigger_queue`（pending/running/done/dropped，7 天终态清理） | payload/eventName/triggerId/三时间戳 | 行与 `loop_runs` 零关联（对不上哪次排队对应哪次执行）；dropped 事件 UI 不可见（只有 queuedCount 总数） |
| 执行层 | `loop_runs`（running/success/failed/stopped） | triggerOutput/renderedPrompt/agentConversationId/loopDir/error/起止时间 | 无 taskId、无 eventName（触发源溯源丢失在队列层）；`stopped` 是死枚举（无赋值无端点）；run 只在完成时才有 conversationId（运行中无进度锚点）；保留策略缺失（全文 prompt 无限增长） |
| 证据层 | `audit_events` / `tasks` / 会话 / `loopDir` 产出目录 | 全部已存在 | run 与它们无双向链接（task 不回写 loopRunId；产出目录无入口） |

展示层**只有 LoopDetailPage 一处**，且缺口实锤：

- 统计卡是对已加载 50 条前端算数（loop-runner `listRuns limit:50` 硬编码），不是真统计；
- 表格无耗时、无触发源、无分页 UI（store 已支持 `before` 游标但 API 未透出）、无筛选；
- running 行只靠用户手动点「立即运行」后的 2 秒延时刷新，无轮询；
- WorkflowsPage 卡片零执行信息（用户在「工作流」页看不到工作流跑得怎么样）；
- 无 run 详情页（只有行内展开 renderedPrompt）；loopDir 产出物无任何入口；
- `loop.delete` 不级联清 `loop_runs`（孤儿行滞留）。

## 1. 架构定位

**不新造子系统。** 执行记录 = 已有两层记录 + 关联键打通 + 查询/聚合 API + 三层展示。平台已有的抽象各归其位：

```
触发事件(trigger_queue) ──runId 回写──▶ 执行记录(loop_runs) ──taskId/conversationId──▶ 证据层
   排队时长/dropped 留痕              唯一执行事实行                    会话审计·任务·产出目录
```

三条原则：

1. **run 是唯一执行事实行**：一次 fire = 一行 `loop_runs`。队列行是它的前置事件（经 runId 关联），会话/审计/任务/产出目录是它的外链证据（经 id 关联）。所有查看/统计只面向 run，不向用户暴露两表。
2. **复用既有通道**：停止复用任务中断通道（`cancelPendingApprovals` + abortSignal）；产出物复用文件内容回读守卫模式；深挖复用审计页 conversationId 过滤；实时性 M1 用条件轮询（存在 running 行时 3s），不新增 SSE 面。
3. **为多步编排留位不预支**：四缺口之四（DAG）落地时，run 升级为 run→steps 两级即可，本设计的列表/详情形态不变，详情页加步骤条。M1 不建 steps 表。

## 2. 数据模型收口（M1）

`loop_runs` 扩列（`ALTER TABLE ... ADD COLUMN`，迁移容忍存量 NULL）：

- `taskId TEXT`：run 内 `orchestrator.handleMessage` 返回 conversationId 的同时回写 taskId（需 dispatch-flow 把 taskId 透传给返回值或由 run 侧查询；实施时确认最小穿透点，四缺口之三的 run→task 半边）。运行中即可提供进度锚点。
- `eventName TEXT`：fire 时从队列行带入（manual / scheduler / hook 路径 / event 名 / git sha），run 自带触发源溯源，不再依赖 join 队列表。
- `stoppedAt TEXT`：stop 端点赋值，激活 `stopped` 死枚举（四缺口之一）。

`trigger_queue` 扩列：`runId TEXT`——`runOnce` 创建 run 后回写到被 claim 的队列行（`markDone` 前置或并入）。由此：

- 排队时长 = run.startedAt − queue.createdAt，详情页可算；
- dropped 行（含溢出丢弃）可按 loop 列出，「事件被丢」从日志可见升级为 UI 可见。

治理收口：

- `loop.delete` 级联 `DELETE FROM loop_runs WHERE loopId=?` + `trigger_queue.deleteByLoop`（后者已存在）；
- **保留策略（拍板项 D3）**：新增启动时清扫 `cleanupRunsBefore`，建议默认=每 loop 保留最近 500 条或 90 天（先到为准），`triggerOutput/renderedPrompt` 维持全文但受保留期约束；生产实测数据量后再紧。

## 3. API 查询面（全部登记 web-route-guards，属主校验复用 requireOwnedLoop/Workflow）

| 端点 | 语义 |
|---|---|
| `GET /api/loops/:id/runs?limit&before&status` | 现有端点透出游标分页 + 状态筛选（store 已支持 before，补 status 过滤） |
| `GET /api/loops/:id/runs/stats` | 后端真聚合：total/success/failed/stopped、成功率、平均/最大耗时、近 7 天逐日分布、排队中被丢弃数（join queue dropped 行） |
| `GET /api/loops/:loopId/runs/:runId` | run 详情：run 本体 + 关联队列行（排队时长、eventName）+ taskId 状态 + 产出文件清单 |
| `POST /api/loops/:loopId/runs/:runId/stop` | 停止：标记 stopped + `cancelPendingApprovals(conversationId)` + 经 runtime-manager abortSignal 中止底层轮次（拍板项 D4：强停止 vs 仅标记） |
| `GET /api/workflows/:id/runs` | workflow 视角反查（`loop_runs.workflowId` 列已存在，补 `idx_loop_runs_workflow(workflowId, startedAt DESC)` 索引；跨引用它的所有 loop） |
| `GET /api/loops/:loopId/runs/:runId/outputs[?path=]` | 产出目录清单/文本预览：server 端 realpath 复判限制在 `loopDir` 内（复用敏感读守卫口径），只读、大小上限 |
| `GET /api/workflows`（改造） | 列表附带每项 lastRun 摘要（状态/时间/所属 loop），单条 GROUP BY 聚合防 N+1 |

不做：跨 loop 全局时间线 `/api/runs` 留 M2（拍板项 D2）；重跑 API 留 M2（拍板项 D5）。

## 4. 展示方案（三层）

### L1 列表层 ——「跑得怎么样」10 秒可判

**LoopDetailPage（主阵地，本轮强化）**

- 统计卡改后端 stats：总轮次 / 成功 / 失败 / 平均耗时（替换前端 50 条算数）；队列溢出丢弃数 >0 时以警示行显示（与现有 queuedCount 提示同形态）。
- 轮次表格列：**开始时间｜状态｜耗时｜触发源｜触发输出（截断）｜操作**。
  - 耗时：finishedAt−startedAt，running 行显示已运行时长；
  - 触发源：eventName 映射徽标（手动 / 定时 / Webhook / 事件名 / Git）；
  - 操作：详情（进 L2）· 跳会话 · 停止（仅 running，调 stop 端点）。
- 交互补齐：状态筛选 tab（全部/运行中/成功/失败）+「加载更多」游标分页；**存在 running 行时每 3 秒轮询，全静止即停**（不自建 SSE）。
- 行内展开保留但瘦身（错误 + 触发输出摘要），全文归 L2 详情页。

**WorkflowsPage 卡片（零成本补盲区）**

- 卡片加「最近执行」行：状态徽标 + 相对时间（如「3 分钟前 · 成功」），数据来自 `GET /api/workflows` 附带摘要；未运行过显示「从未运行」。点击卡片 → 所属 loop 详情页（run 列表锚点）。

### L2 详情层 —— run 详情独立页 `/loops/:loopId/runs/:runId`

独立路由页而非抽屉（拍板项 D1）：字段多、URL 可分享可从通知深链（`loop.run_failed` 站内信 link 可升级直达 run）；与平台「审计=单页+URL mode」的形态惯例一致。

布局自上而下：

1. **状态头卡**：状态徽标 / 起止时间 / 耗时 / 触发源 / 排队时长；running 时显示已运行时长并轮询。
2. **关联跳转区（chips）**：会话（`/?conv=`）· 会话审计（AuditPage 带 conversationId）· 任务（taskId 存在时）· 产出目录（锚点滚动到产出区）。
3. **输入区（折叠 pre）**：触发输出全文（wrapUntrusted 后原文）→ 渲染后 prompt。
4. **错误区**：failed/stopped 时置顶显示 error 全文。
5. **产出区**：loopDir/outputs 文件清单（名/大小），文本类点击行内预览（复用附件预览形态），经 outputs 只读端点。

### L3 深挖层 —— 复用既有页面，零新开发

- 会话内逐轮 LLM/工具明细 → AuditPage 按 conversationId 过滤（已有）；
- 任务状态机/审批卡 → 既有任务视图（taskId 打通后自然可达）。

### 验收样板（场景即验收）

- 用户 A 的 git 触发工作流夜里失败：早上打开 WorkflowsPage 卡片即见「昨晚 02:14 · 失败」→ 点入 loop 详情 → 失败行点详情 → 错误区看到 renderPrompt 失败原因 → chips 跳会话审计还原现场。全程 ≤3 次点击。
- 事件触发器队列溢出丢事件：loop 详情页顶部警示行可见丢弃数，不再只存在于服务端日志。
- 运行中轮次：running 徽标 + 已运行时长自动跳动，停止按钮可中止卡死的会话。

## 5. 里程碑

- **M1（本轮范围）**：§2 数据收口 + §3 API（除 /api/runs、重跑）+ §4 L1 两页强化 + L2 run 详情页。四缺口随行关闭三缺口（stopped 端点、task→run 关联半边、TaskStore 分页不在本轮但 run 侧已带 taskId 查询）。
- **M2（拍板后另立轮）**：全局执行时间线 /runs、重跑 API、SSE 实时推送（替代轮询）、通知深链直达 run 详情。
- **M3（远期，多步编排落地时）**：run→steps 两级，详情页加步骤条，列表形态不变。

## 6. 决策点（待拍板）

| # | 问题 | 建议 |
|---|---|---|
| D1 | run 详情形态：独立页 vs 抽屉 | **独立页**（URL 可分享/可深链/信息量大） |
| D2 | 全局执行时间线 /runs 是否本轮做 | **M2**（M1 已覆盖 95% 场景；全局页价值在 admin 巡检，可并入审计页 tab） |
| D3 | loop_runs 保留策略 | **500 条/loop 或 90 天先到为准**，启动清扫；量级实测后再调 |
| D4 | stop 语义：仅标记 vs 强停止 | **强停止**（复用 cancelPendingApprovals + abortSignal，与任务中断同通道）；abort 不可达时降级仅标记 |
| D5 | 从 run 一键重跑（同 payload 重 fire） | **M2**（有用但非记录查看主干；避免本轮范围膨胀） |
