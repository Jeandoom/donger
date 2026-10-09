# 自动化模型重构：移除 Loops、触发器→事件三分法、触发/执行记录体系

- 日期：2026-10-09
- 状态：**已拍板，实施中**（D1-D6 全部裁决见 §12）
- 关联：2026-10-09-workflow-run-history-design.md（执行记录先行设计，其 L2/L3 结论被本轮吸收）；2026-09-28-event-trigger-feedback-design.md（队列与事件触发器契约）

## 0. 需求对码

| 需求 | 结论 |
|---|---|
| 移除 loops 模块，自动化 = 事件 + 工作流 | 可行。启用态收归 workflow.enabled，Loop 全链退役 |
| 触发器改名「事件」，三分：系统默认 / 定时 / 调用 | 可行。现 4 类型（scheduler/hook/event/git）映射到 3 类型 |
| 删除代码提交（git）类型 | 可行。GitWatcher、git 配置、lastState、getGitLastSha 全删 |
| 定时事件分无条件/有条件两种 | 可行。现 scheduler 强制 source+matcher；补「纯定时无 source」形态即可 |
| cron 改交互配置，UI 覆盖全部 cron 表达力 | 可行。预设模式 + 五字段高级编辑器；存库仍是 cron 字符串，node-cron 零改动 |
| 调用事件复用 hook，路径随机后缀、每事件独立路径、支持 GET+POST、POST body `{query,data}` | 可行。随机路径机制已存在（缺省生成），改为强制；GET 为新增；payload 归一 |
| 工作流 trigger 改「订阅事件」下拉，事件上下文可在提示词引用 | 可行。triggerId→eventId 改名；模板引擎从单变量升级为变量表 |
| 删除「输出子目录」 | 可行且是净简化：loopDir/运行目录/sanitize 全删，产出即会话 |
| 事件模块加触发记录（点看上下文） | 新表 event_firings |
| 工作流模块加执行记录（点看完整对话） | loop_runs 升级 workflow_runs 并吞并 trigger_queue |

**可行性总评：全部可行，无技术阻塞。** 唯二要小心的点是存量数据迁移（loops→workflow 合并）与「触发记录 GET 回调被预取误触」的运营面风险，均有成熟对策（见 §10）。

## 1. 现状关键事实（设计依据）

1. 链路：`Trigger(4型) → Workflow(triggerId/agentId/promptTemplate/outputSubdir) → Loop(workflowId,enabled,运行态) → LoopRunner.fire → trigger_queue → drain → runOnce → loop_runs + orchestrator.handleMessage`。三个分发器（Scheduler/HookRegistry/EventTriggerDispatcher）都靠「owner 级交叉过滤 enabled loops」扇出。
2. **运行会话现状是混杂的**：LoopRunner 发 `IncomingMessage{threadId: loopId, channelId:"web"}` 且不带 conversationId，orchestrator 落到 `getLatestConversationId`——**每次执行追加进用户最近的 web 会话**。与「正常查看」诉求冲突，本轮必须改为独立运行会话。
3. hook 已有随机路径机制：POST /api/triggers 缺省 path 时生成 `/hooks/<16 hex>`；`/hooks/*` 免认证入口带 IP 120/min + path 20/min 双限流；现仅 POST 实质可用（GET 进来 body 为空）。
4. scheduler 强制 `source(http|file)+matcher`；node-cron 5 字段；`refreshByTrigger` 幂等重注册。
5. 系统事件注册表 `EVENT_TRIGGER_NAMES=["feedback.created"]`，payload=JSON 字符串，经 wrapUntrusted 插入模板；仅 `{{triggerOutput}}` 一个变量。
6. trigger_queue：per-loop FIFO、pending 上限 200 溢出落 dropped、重启 running→pending 重投（at-least-once）、终态 7 天清理。loop_runs 与队列行**零关联**。
7. conversation 已有 `createWithAgent(userId, channelId, title, agentId, opts)` 与 `archived` 列；无 origin 标记。
8. 前端规模：TriggerEditorPage 686 行（cron 手输）、LoopsPage+LoopDetailPage 574 行（整体删除）、WorkflowEditorPage 290 行（改订阅+删 outputSubdir）。

## 2. 目标架构

```
事件 Event（3 型：system / schedule / call）
   │ fire(context, source) —— 统一入口 EventDispatcher
   ├─▶ EventFiring（触发记录：1 次 fire 1 行，0 订阅也记）
   └─▶ 扇出到 enabled 订阅者：WorkflowRun(status=queued)
            │ per-workflow 泵（FIFO claim，pending 上限，重启重投——原队列语义原样迁入）
            ▼
        WorkflowRun(running) → 独立运行会话(createWithAgent) → orchestrator.handleMessage
            ▼
        success / failed / stopped（conversationId 回写）
```

三表分工：**Event=资产，EventFiring=触发事实（事件视角），WorkflowRun=执行事实（工作流视角）**。原 trigger_queue 表退役——队列语义不删，整体并入 WorkflowRun 的 `queued` 状态与泵逻辑（三表变两表，队列行与执行行不再需要关联键）。

## 3. 数据模型

### 3.1 Event（原 triggers 表改名 events，type 收敛）

```ts
type: "system" | "schedule" | "call"
config:
  system:   { name: EventTriggerName, matcher }            // 注册表不变，后续扩充在此加
  schedule: { cron, mode: "unconditional" | "conditional",
              source?: http|file, matcher? }               // conditional 才有 source+matcher
  call:     { path: "/hooks/<random>", methods 默认 GET+POST,
              matcher?, responseStatus, responseBody }
runtime 列: lastFiredAt, nextRunAt(schedule 展示用)
```

- system：创建/编辑仍 admin-only（事件 payload 含全体用户反馈正文，理由不变）。
- schedule：无条件=纯定时，到点即 fire，context=`{firedAt, eventName}`；有条件=现行为原样（source 抓取+matcher 判定）。
- call：**path 服务端生成、用户不可指定**（新事件强制随机；`HOOK_PATH_TAKEN` 抢注逻辑随自定义 path 一起退役）；GET 与 POST 同时支持（见 §5.3）；UI 展示完整可复制 URL。

### 3.2 Workflow（吸收 Loop）

```ts
eventId（原 triggerId）, agentId, promptTemplate,
enabled: bool,                    // 原 Loop.enabled
lastRunId, lastRunAt, lastError,  // 原 Loop 运行态
// 删除：outputSubdir（列保留弃用或 DROP，推荐 DROP 干净）
```

### 3.3 EventFiring（触发记录，新表）

```ts
id, eventId, ownerId, source("manual"|"schedule"|"call"|"system"),
context TEXT(截断 32KB), matchedWorkflowCount, firedAt
```

保留 30 天（启动清扫）。owner-only 可见。**这是「点看触发上下文」的载体**：详情= context 全文（JSON 查看器）+ 本次扇出的 run 列表（join WorkflowRun.firingId）。

### 3.4 WorkflowRun（原 loop_runs 升级 + 吞并 trigger_queue）

```ts
id, workflowId, eventId, firingId,
eventName("manual"|"schedule"|"call:<path>"|"system:<name>"),
status: queued | running | success | failed | stopped | dropped,
context（原 triggerOutput）, renderedPrompt,
conversationId, taskId?, error,
queuedAt, startedAt, finishedAt
```

- 队列语义原样迁入：per-workflow FIFO claim（queued→running 单飞）、pending 上限（溢出落 dropped+站内信，沿用现通知）、重启 running→queued 重投、终态保留期 7→30 天（与触发记录对齐，拍板项）。
- `stopped` 随本轮真正落地：`POST /api/workflows/:id/runs/:runId/stop` = cancelPendingApprovals + abortSignal 中止轮次（执行记录先行设计 D4 的强停止方案）。

## 4. 统一 fire 管线（LoopRunner → EventDispatcher）

```
fire(eventId, context, source):
  1. EventFiring 落行
  2. 扇出：owner 级查 enabled 且 eventId 命中的 workflows（复用现交叉过滤写法）
  3. 每个 workflow：enqueue WorkflowRun(queued, 上限判定) → pump(workflowId)
pump: claim queued→running → createWithAgent(独立会话, 标题「⚙️ wf名 · MM-dd HH:mm」)
      → renderPromptTemplate(template, 变量表) → handleMessage({conversationId, unattended:true})
      → success/failed 回写（含 conversationId/taskId）
```

三个分发器同构改造，均变薄（只做「抓上下文 + 判定」）：

- **SchedulerService**：按 event 注册 cron（非按 loop）；注册条件=存在 enabled 订阅者；tick → 无条件直接 fire / 有条件走 testTrigger 抓取判定后 fire。
- **CallEndpoint（原 HookRegistry）**：路径命中 → 归一 payload（§5.3）→ matcher → fire。
- **SystemEventDispatcher（原 EventTriggerDispatcher）**：按 `event.name` 命中注册表事件 → matcher → fire。

`unattended:true` 语义（无人值守强制问询）原样保留。

## 5. 三类事件规格要点

### 5.1 定时事件 + Cron 交互组件

新组件 `CronBuilder`（web 共用，两处复用：无条件/有条件同一组件）：

- **预设层**（覆盖 90% 用法）：每 N 分钟 / 每小时第 M 分 / 每天 HH:mm / 每周（多选周几）HH:mm / 每月（多选几号）HH:mm / 每年 M 月 D 日 HH:mm。
- **高级层**：五字段（分 时 日 月 周）逐字段编辑，每字段四种模式——`*`（每）/ `a,b,c`（指定列表）/ `a-b`（范围）/ `*/n` 或 `a-b/n`（步进）。四种模式的笛卡尔组合可表达**全部**标准 5 字段 cron。
- 生成物=标准数字+`*,-/` 表达式（不发英文名/`?`，规避 node-cron 方言差异），实时回显表达式与人类可读描述（如「每 5 分钟」「每周一、周五 09:00」）；非法组合即时报错。
- 存库形态不变（cron 字符串），调度器零改动。`nextRunAt` 预览不做新依赖（node-cron 无 next 接口；M2 可用轻量自算，拍板项）。

### 5.2 系统事件

注册表机制原样（`feedback.created` 在册，后续 KB 变更/会话完结等加名即用）。UI 上「系统默认」类型=选择注册表中的事件名+配置 matcher（admin-only 门沿用）。触发记录对系统事件尤其有价值（反馈事件当前完全不可观测）。

### 5.3 调用事件（GET+POST，payload 归一）

- POST：body 须为 `{"query":"hello","data":{}}`；`query` 缺省空串、`data` 缺省 `{}`；body 非 JSON 时降级「整个 body 作为 query、data 为空」（宽容解析，外部系统最简接入）。
- GET：查询串解析——`?query=...` 之外的全部参数收进 `data` 对象（`data.k=v` 形式支持一层嵌套，平铺参数收为 `{k:v}`）。
- 归一后的 context：`{ query, data, firedAt, method, path }`（data 为对象时模板变量给 `JSON.stringify(data, null, 2)`）。
- 匹配器判定对象=归一后 context 的 JSON（与现状 body 判定兼容）。
- 复用现有免认证通道的双限流（IP+path）与体积上限；GET 天然可被浏览器预取/扫描器误触，靠随机不可猜路径+限流兜底（决策点 D3：是否加 token）。

## 6. 提示词模板：单变量 → 变量表

- `renderPromptTemplate(template, vars: Record<string, string>)`：逐 key replaceAll；未知 `{{xxx}}` 保持字面量。**`{{triggerOutput}}` 恒在**（=整个 context JSON），存量模板零迁移。
- 各类事件暴露的变量（UI 按所选事件类型渲染 chip，点击插入光标处）：
  - 通用：`{{triggerOutput}}` `{{firedAt}}` `{{eventName}}`
  - 调用事件追加：`{{query}}` `{{data}}`
  - 定时事件：无条件仅通用变量；有条件 `{{triggerOutput}}`=源内容
- 编辑器默认模板按事件类型给建议值（如无条件定时：「当前时间 {{firedAt}}，请执行例行任务」）。
- wrapUntrusted 包装语义原样保留（外部数据定界注入）。

## 7. 记录查看与显示（对齐先行设计的结论，落点更新）

- **执行记录**（工作流视角）：WorkflowsPage 卡片带启用开关+最近执行摘要；工作流详情内执行记录列表（状态/耗时/触发源/上下文预览/统计卡后端真聚合）；行点击 → run 详情：状态头卡+错误+输入区（context/renderedPrompt 折叠）+ **「打开完整对话」→ 独立运行会话**（`/?conv=`）。运行中轮询 3s 自停；stop 按钮仅 running。
- **触发记录**（事件视角）：EventsPage / 事件详情内触发记录列表（时间/来源/扇出数/上下文预览）；行点击 → firing 详情：context 全文 JSON 查看器+本次扇出的 run 列表（直达执行记录）。
- 「查看完整对话」= 跳转运行会话（会话页已有完整渲染、附件、审计深链，零新代码）；不做内嵌转录渲染（决策点 D4）。

## 8. API 面（web-route-guards 全量重登记）

```
GET/POST /api/events                  GET/PUT/DELETE /api/events/:id
POST /api/events/:id/test             （定时有条件=抓取试判定，沿用 testTrigger 语义）
GET  /api/events/:id/firings?limit&before    GET /api/events/:id/firings/:fid
GET  /api/workflows                   （列表带 lastRun 摘要，GROUP BY 防N+1）
POST /api/workflows/:id/enable|disable       （原 loops enable/disable 迁移落点）
POST /api/workflows/:id/run           （手动触发一轮：有条件定时走试抓取，其余空 context）
GET  /api/workflows/:id/runs?status&limit&before
GET  /api/workflows/:id/runs/stats
GET  /api/workflows/:id/runs/:runId
POST /api/workflows/:id/runs/:runId/stop
```

退役：`/api/loops/*` 全部、`/api/triggers/*`（前端同步切换；不做 410 兼容，前后端同版发布）。

## 9. 迁移方案（migrate() 内一次性，先备份）

1. `events` 建表 ← `triggers` 数据映射：scheduler→schedule(conditional)（source 必填故存量全为有条件）、hook→call（**保留存量 path**，不破坏外部系统；仅新建强制随机）、event→system、**git→删除行**，引用 git 的 workflows 置 enabled=0 并打迁移日志。
2. `workflows` 扩列 enabled/lastRunId/lastRunAt/lastError ← 每个 workflow 取其 loops 中最新一条回填运行态，enabled=任一 loop enabled；DROP outputSubdir 列与 `loops` 表。
3. `loop_runs` → `workflow_runs`（rename+扩列：firingId/eventName/queuedAt；存量 eventName 尽力回填自 trigger_queue done 行，查不到置 NULL）。
4. `trigger_queue` pending 行 → INSERT 为 `workflow_runs(queued)`（守住 at-least-once），随后 DROP 表。
5. `event_firings` 空表新建（存量触发历史无源可迁，从上线起记录——spec 里明示此断点）。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 迁移多步 SQLite 中途失败 | 迁移包事务 + fixture 库迁移测试（建含 4 型 trigger/loop/queue/run 的存量库断言映射）；上线前生产真库备份（惯例） |
| 多 loop 引用同一 workflow 的存量合并 | 取最新运行态 + enabled 取或；量级小，spec 内写死规则即可 |
| GET 回调被预取/扫描误触 | 随机 16 hex 路径 + 现有 IP/path 双限流；D3 若拍板加 token 再收紧 |
| 触发记录存原始外部 payload | 32KB 截断 + owner-only + 30 天清理 + 详情展示沿用 untrusted 转义 |
| cron builder 与 node-cron 方言 | builder 只产数字与 `*,-/`；非法组合前端即时校验 + 存库前 `cron.validate` 双保险 |
| 前后端同版切换窗口 | /api/loops 与 /api/triggers 直接移除，不做兼容层；发版即切换（单机部署惯例，秒级） |

## 11. 里程碑

- **M1 域+存储+迁移**：domain（event/workflow/workflow-run/event-firing 重写，trigger/loop 删除）、stores、§9 迁移、fixture 迁移测试。
- **M2 运行时**：EventDispatcher+泵（队列语义迁入）、Scheduler 按事件注册、CallEndpoint GET/POST、SystemDispatcher 改名接线、独立运行会话、stop 通道、移除 GitWatcher/loopDir。
- **M3 API**：§8 全量路由+守卫+属主校验，旧路由移除。
- **M4 Web**：CronBuilder 组件、EventsPage/EventEditorPage 重造（686 行页重构+触发记录视图）、WorkflowEditorPage（订阅下拉+变量 chip+删 outputSubdir）、WorkflowsPage 执行记录面、导航（触发器→事件、删循环）、LoopsPage 族删除。
- **M5 收口**：全量测试+E2E 冒烟（三类事件各一发）+ 双远端 + 部署。

## 12. 决策点（已全部拍板，2026-10-09）

| # | 问题 | 裁决 |
|---|---|---|
| D1 | 运行会话在侧栏的可见性 | **同意建议**：完全正常显示，标题带 ⚙️ 前缀可辨识 |
| D2 | 存量 hook 路径 | **不保留**：当前无任何外部系统正式使用，迁移时全部重新生成随机路径；「重新随机化」按钮无需做 |
| D3 | GET 调用事件是否加 token | **同意建议**：不加，随机路径 + 现有 IP/path 双限流兜底 |
| D4 | 执行记录看对话的方式 | **同意建议**：跳转运行会话（`/?conv=`），零新渲染代码 |
| D5 | 记录保留期 | **永久保留**：触发记录与执行记录均不做时间清理，便于回溯（正常数据量不大；行级 32KB 截断仍保留；启动清扫仅保留正确性语义——重启 running 重投——不做任何按时间的删除） |
| D6 | 事件触发队列模型 | **单一全局队列，容量 10**：事件触发的执行进一个独立全局 FIFO 队列（status=queued 的 WorkflowRun 全平台一队，不分 workflow 各自设上限）；**超出容量时该次任务直接失败**（落 WorkflowRun status=failed，error=「触发事件队列已满（容量 10），本次执行未运行」），**失败原因必须在执行记录中可见**，并走既有失败通知通道。claim 规则：取最旧 queued 且其 workflow 无 running 行（同工作流串行、跨工作流并行）；手动「立即运行」入队但豁免容量检查 |

### D6 落定的队列语义（替换原 §3.4 队列描述）

- 入队：`fire()` 扇出时统计全局 queued 行数，≥10 → 新 run 直接落 `failed`（错误原因进执行记录 + 站内信走 run_failed 通道）；<10 → 落 `queued` 进队。
- 出队：全局泵 claim「最旧 queued 且所属 workflow 无 running 行」→ 标 running 异步执行 → 完成后回调泵继续抽；单全局泵守卫防重入。
- 恢复：启动时 `running → queued`（同 run 行重投，at-least-once 保留）；**无任何终态清理**（D5）。
- 手动运行：入队走同一泵（保证同 workflow 串行），豁免容量检查。
