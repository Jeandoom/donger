# 执行完成事件设计（智能体执行完成 / 工作流执行完成 → 可订阅、可级联编排）

- 日期：2026-10-19
- 状态：**M1 已实施，e2e 全绿**（§13 前八项覆盖；未提交未部署）。实施落点：注册表/配置 src/domain/event.ts、payload 契约 src/domain/event-payloads.ts、终态 emit+级联守卫+简报变量 src/orchestrator/event-dispatcher.ts、过滤路径 src/orchestrator/system-event-dispatcher.ts、权限收窄/主体校验/自订阅拒绝 src/adapters/web-channel.ts、run 两列迁移 src/adapters/sqlite-workflow-run-store.ts、UI web/src/pages/EventEditorPage.tsx + WorkflowEditorPage.tsx、接线 src/index.ts。e2e：test/orchestrator/execution-completed-events.test.ts（7）、test/adapters/web-channel-execution-events.test.ts（3）、test/domain/execution-completed.test.ts（5）。M2（产物库/标签/触发链展示）未动。
- 关联：docs/superpowers/specs/2026-10-09-events-workflows-refactor-design.md（事件/工作流基座）、2026-10-09-workflow-run-history-design.md（挂起，触发链展示与本设计共用 causedByRunId）、2026-10-16-feedback-auto-dev-deploy-l2-design.md（级联场景样板）
- 业界参照：MCP 工具结果 content-blocks 模式、A2A artifact 模式（薄信封 + 自由内容；结构化只在代码消费层）

---

## 1. 目标与非目标

**目标**：把「执行完成」变成可订阅事件——用户创建「智能体执行完成」或「工作流执行完成」事件（多选主体 + 选触发时机），工作流订阅后形成 A 完成→触发 B 的级联编排。事件下游消费者是 LLM，payload 内容层零结构化义务，下游默认收到自然语言简报而非 JSON。

**非目标（显式不做）**：
- join/汇合（等 N 个事件齐再触发）——需要新状态机制，另立项；
- 对话级完成事件（交互式聊天会话完结触发）——语义模糊，v1 事件源仅 workflow run 终态；payload 的 `executionType` 字段预留；
- 智能体侧输出契约（outputContract 校验）——结构化由平台抽取兜底；
- 外部 webhook 出站（完成事件→外部系统）——call 事件是入站，出站是另一能力；
- 存量三类事件（feedback.created / schedule / call）的 matcher 机制不动。

## 2. 已拍板决策记录

| # | 决策 |
|---|---|
| D1 | 两类事件并存：智能体执行完成、工作流执行完成。同一 firing 源（workflow run 终态），两个订阅视角；同一次 run 可同时命中两类，各自扇出 |
| D2 | 事件配置为一等字段（`subjects` 多选 + `timing`），dispatch 按 run 行字段过滤，**不走 payload matcher**。用户界面 = 选类型 → 多选智能体或工作流 → 选时机，无第三个概念 |
| D3 | payload = 薄信封（机器消费）+ 自由内容（LLM 消费）。内容无 schema；下游 runner 渲染自然语言简报注入，LLM 默认看不到 JSON |
| D4 | 权限面：事件创建的候选集 = 我可使用（自己创建 + 分享给我的）；硬守卫 = `run.ownerId === 订阅工作流.ownerId`（事件与订阅工作流同属主，即 event.ownerId）。分享的智能体只有「我名下的执行」触发我的事件 |
| D5 | 级联守卫：`workflow_runs` 加 `causedByRunId`/`cascadeDepth` 两列，链深超限（默认 5，env 可配）拒绝入队（落 failed + 通知）；保存工作流时静态拒绝自订阅 |
| D6 | 智能体「工作流协作」标签 = 画像：事件选择器默认过滤面 + 工作流上下文执行时注入输出约定提示；**不是** payload 硬契约，未打标智能体的事件照常触发 |
| D7 | 文件通道（产物库导出/下游物化）放 M2，payload schema 的 `files` 字段 M1 先行恒为 `[]`；单文件上限 20MB（对齐上传限制） |
| D8 | 触发时机（timing）默认「全部」（success/failed/stopped 均触发），UI 可改 |
| D9 | system 类型事件权限收窄：`feedback.created` 维持 admin-only；两个完成事件**全员可建**（场景主体是普通用户自己的智能体/工作流） |

## 3. 现状锚点（已核实）

| 能力/缺口 | 锚点 |
|---|---|
| 系统事件注册表仅 `feedback.created` | src/domain/event.ts:19 |
| system 事件配置 `{name, matcher}`，注释注明 admin-only | src/domain/event.ts:11,71-75 |
| Event 带 ownerId（属主守卫可用） | src/domain/event.ts:79 |
| 事件三分法统一 fire：落 event_firings→扇出→泵 | src/orchestrator/event-dispatcher.ts:62-81 |
| 队列容量 10 全局，溢出落 failed+通知（守卫复用此路径） | src/orchestrator/event-dispatcher.ts:41,118-133 |
| run 终态三处：success/failRun/stopRun，仅更新行+通知，**不回流事件** | src/orchestrator/event-dispatcher.ts:197-206,240-255,276-294 |
| run 行含 agentId 所在 workflow、status、eventName、conversationId、context | src/domain/workflow-run.ts |
| prompt 变量渲染 triggerOutput/firedAt/query/data；wrapUntrusted 在渲染管线统一做 | src/domain/event.ts:151-159 |
| system 事件 dispatch：listAll 过滤 name→matcher→fire（无属主过滤） | src/orchestrator/system-event-dispatcher.ts:21-40 |
| payload 契约先例 FeedbackCreatedFact | src/domain/event-payloads.ts:8-27 |
| 手动运行豁免队列容量 | src/orchestrator/event-dispatcher.ts:87-94 |

## 4. 事件模型

### 4.1 注册表与配置

`SYSTEM_EVENT_NAMES` 追加两个名字（src/domain/event.ts:19）：

```ts
export const SYSTEM_EVENT_NAMES = [
  "feedback.created",
  "agent.execution.completed",
  "workflow.execution.completed",
] as const;
```

`EventSystemConfigSchema` 扩展（对两个新名字必填，`feedback.created` 禁止携带）：

```ts
export const EventSystemConfigSchema = z.object({
  name: z.enum(SYSTEM_EVENT_NAMES),
  matcher: TriggerMatcherSchema.optional(),          // 仅 feedback.created 使用
  subjects: z.array(z.string()).min(1).optional(),   // 智能体id / 工作流id 列表
  timing: z.enum(["all", "success", "failed", "stopped"]).optional(), // 缺省 all（D8）
});
```

校验规则（schema refine）：`name === "feedback.created"` 时禁 `subjects/timing`、`matcher` 必有缺省；两个完成事件必须给 `subjects`，`matcher` 不接受（留存字段不用）。

### 4.2 权限面（D4 + D9）

- **创建权限**：system 类型事件的 admin-only 限制收窄为按名字分流——`feedback.created` admin-only（现状不变），两个完成事件全员可建。
- **候选集**：智能体多选器与工作流多选器只列「我可使用」集合（自己创建 + 分享给我的，走既有分享 canUse 口径）。这是 UX 约束。
- **硬守卫**：dispatch 时 `payload.ownerId !== event.ownerId` 则跳过该事件（不 fire）。分享的智能体被属主执行时不会触发分享对象的事件——只有订阅者自己名下的 run 触发。与审计轮属主铁律同源。

### 4.3 dispatch 过滤路径（新事件不走 matcher）

`system-event-dispatcher.dispatch(eventName, payload)` 内部分流：

- `feedback.created`：现路径不变（listAll → matcher → fire）；
- 两个完成事件：listAll 过滤 `type==='system' && system.name===eventName` 后，按 payload 中的 `agentId/workflowId/status/ownerId` 对 `subjects/timing/ownerId` 做集合过滤，命中才 fire。**不解析 matcher、纯内存集合判断**。

emit 点（run 终态）调 `dispatch` 时 fail-open（沿用 web-channel.ts:4297-4312 先例）：dispatch 抛错只记 warn，不影响 run 终态落库。

## 5. Firing 源与 payload 契约

### 5.1 终态 emit 点

`event-dispatcher.ts` 三处终态转移后各加一次 emit（先落库后 emit，fail-open）：

| 终态 | 位置 | payload.status |
|---|---|---|
| 成功 | `updateRun({status:"success"})`（:197-206） | `success` |
| 失败 | `failRun()`（:240-255） | `failed` |
| 终止 | `stopRun()`（:276-294，实际发生状态转移时） | `stopped` |

手动运行同样 emit（run.eventName="manual" 时不豁免——手动也是执行完成）。`trigger.source` 从 `run.eventName` 推导：`system:*` 前缀 → `event`，其余原样。

### 5.2 payload（薄信封 + 自由内容，D3）

`domain/event-payloads.ts` 新增 `ExecutionCompletedFact` 与两个构造函数：

```jsonc
{
  "schemaVersion": 1,
  "event": "agent.execution.completed",     // 或 workflow.execution.completed
  "runId": "run_…",
  "agentId": "agt_…",   "agentName": "…",
  "workflowId": "wf_…", "workflowName": "…",
  "ownerId": "u_…",                          // 属主守卫消费，模板作者不感知
  "status": "success",                       // success | failed | stopped
  "startedAt": "…", "endedAt": "…", "durationMs": 184000,
  "error": null,                             // failed/stopped 时为简要错误文本（≤500 字）
  "trigger": {
    "source": "event",                       // event | schedule | call | manual
    "eventId": "evt_…",                      // 可空（手动/级联上游无直接事件时）
    "causedByRunId": null,                   // 级联上游 run；链根为 null
    "cascadeDepth": 0                        // 根=0
  },
  "result": {
    "text": "<最终 assistant 回复原文，markdown 原样，截断 ≤2000 字符，截断尾加 [已截断]>",
    "files": []                              // M1 恒空；M2 填产物（§7）
  }
}
```

`result.text` 从 run 的会话（`workflow_runs.conversationId` → 转录缓存）取最终 assistant 回复；转录读取失败置空串兜底，不阻塞 emit。

## 6. 简报渲染与模板变量

**JSON 是存储格式，简报是呈现格式**（MCP content-blocks 渲染进模型上下文的同款做法）。

- 变量表（`buildPromptVars`，src/domain/event.ts:151）追加：
  - `{{outputSummary}}` = `result.text`（走 wrapUntrusted，同 triggerOutput 现规则）；
  - `{{filesManifest}}` = 物化后清单文本（M2 前恒空串）；
  - `{{triggerOutput}}` 恒在（= payload 原文 JSON），存量模板零迁移。
- 内置简报模板常量（`domain/event-payloads.ts` 导出，M1 提供）：

```
【上游完成通知】{workflowName} 中的智能体 {agentName} 已{状态词}（耗时 {duration}）。
结论：
{outputSummary}

交付文件：
{filesManifest 或「（无）」}
```

- 工作流默认 `promptTemplate` 保持 `'{{triggerOutput}}'` 不变（存量零影响）；UI 上**新建/编辑订阅完成事件的工作流时预填简报模板**，用户可改。

## 7. 产物库（M2，D7）

- **导出**：run 终态时扫描该会话 cwd 的变更记录（audit_events 变更条目，同「变更 tab」数据源），收集 created/modified 文件，排除 `.git`、`node_modules`、`./artifacts` 自身；拷贝到 `data/artifacts/run-<runId>/`；单文件 >20MB 跳过（简报中注明「过大未纳入」）。
- **归类**：按扩展名/mime 映射 `category: image|document|code|audio|video|archive|other`。
- **句柄**：`ref: artifact://run-<id>/<name>`，存储映射 ref→真实路径，任何对外面（payload/简报/UI）不暴露盘路径。
- **下游物化**：执行订阅工作流前，把 `result.files[]` 拷入新会话 cwd `./artifacts/<清洗后的文件名>`（防 `../` 注入，沿用变更 tab path→key 轮教训；重名加序号）；填 `{{filesManifest}}`（每行 `./artifacts/xxx — 类型 大小`）。
- **保留策略**：跟随 run 记录（现状永久保留，D5 of run-history spec），run 删除时连带清理；GC 清道夫不单独清理 artifacts 目录（挂在 run 生命周期上）。

## 8. 级联守卫（D5）

- **schema**：`workflow_runs` 迁移加两列 `caused_by_run_id TEXT NULL`、`cascade_depth INTEGER NOT NULL DEFAULT 0`（双写 run-store 的 migrate，幂等加列，同 triggerId 摘除轮的收口纪律：核对列清单）。
- **传递**：run 终态 emit → 下游事件 fire 入队时，从 payload.trigger 读上游 `causedByRunId/cascadeDepth`，写入新 run 行：`causedByRunId = 上游 runId`，`cascadeDepth = 上游 depth + 1`。根（手动/schedule/call/feedback）为 null/0。
- **截断**：fire 入队前校验 `cascadeDepth > MAX_CASCADE_DEPTH`（env `DONGER_EVENT_MAX_CASCADE_DEPTH`，默认 5）→ 不入队，落 failed 行（error="级联深度超限"）+ 通知，复用队列溢出路径模式（:118-133）。
- **静态自订阅拒绝**：保存工作流时校验——订阅 `workflow.execution.completed` 且 subjects 含自身 id，或订阅 `agent.execution.completed` 且 subjects 含本工作流绑定的 agentId → 400 拒绝（消息说明环路风险）。非自环环路（A→B→A）由链深兜底，不做图分析。

## 9. 智能体「工作流协作」标签（D6）

- **字段**：agent 档案 meta 加布尔 `workflowTag`（落在 agent 编辑页既有 meta 载体上，实现时钉死具体字段位；无表迁移）。
- **UI**：智能体编辑器加开关「用于工作流协作」；事件创建的智能体多选器**默认只列已打标**，提供「显示全部」展开。
- **运行时**：工作流上下文执行打标智能体时，prompt 末尾追加固定输出约定（常量）：「最终回复以 markdown 给出结论摘要；所有交付文件写入当前目录 ./artifacts/ 下。」未打标不注入、不阻断任何功能。
- **边界重申**：标签不是准入门——未打标智能体在完成事件下照常触发，payload 由平台从 run 侧抽取。

## 10. UI 变更

| 页面 | 变更 |
|---|---|
| 事件编辑器 | 事件类型新增「智能体执行完成」「工作流执行完成」；选中后出主体多选器（候选=我可使用；智能体默认过滤打标 + 显示全部）与触发时机单选（默认全部） |
| 工作流编辑页 | 事件选择器正常列出新事件；订阅完成事件时 promptTemplate 预填简报模板；保存时触发自订阅静态校验 |
| 智能体编辑器 | 「用于工作流协作」开关 |
| （M2）run 历史 | 利用 `causedByRunId` 展示触发链（与挂起的 run-history spec §触发链共用字段） |

## 11. 表结构变更汇总

| 表 | 变更 | 迁移 |
|---|---|---|
| workflows | 无（eventId 订阅机制不变） | — |
| workflow_runs | +`caused_by_run_id`、+`cascade_depth` | 幂等加列 |
| agents | meta 加 `workflowTag` | 无表迁移 |
| events | system 配置 JSON 扩展 subjects/timing（zod 双轨：读容忍/写严格） | 无表迁移 |

## 12. 分期

**M1（链路主干，纯文本）**：注册表+配置 schema+权限收窄 → 终态 emit（text only）→ dispatch 新过滤路径 → 守卫三件套（级联/静态自订阅/属主）→ 模板变量 + 简报模板 → 事件编辑器/工作流编辑页 UI → e2e。
**M2（文件通道 + 画像）**：产物库导出/物化/`{{filesManifest}}` → 智能体标签全链 → run 历史触发链展示（与 run-history spec 合流）。
**不做**：join 汇合、对话级完成、outputContract、webhook 出站（见 §1）。

## 13. e2e 清单

1. **链式两跳**：A（agent A01）完成 → 订阅事件触发 B（agent B01），B 的 renderedPrompt 含简报与 A 的结论原文；
2. **级联截断**：构造 6 跳链，第 6 跳不入队、落 failed 行 + 通知；
3. **自订阅拒绝**：保存订阅自身完成事件的工作流返回 400；
4. **属主隔离**：他人名下对同一分享智能体的执行不触发我的事件；
5. **timing 过滤**：`timing=success` 时 failed run 不触发；
6. **两类事件并存**：同一 run 同时命中智能体完成事件与工作流完成事件，各自扇出；
7. **手动运行**：手动触发的 run 终态同样 emit；
8. **存量回归**：feedback.created 链路（L2 工作流）行为不变；队列容量/泵/重启恢复行为不变；
9. （M2）文件物化：上游产出文件出现在下游 `./artifacts/`，超 20MB 跳过且简报注明。

## 14. 风险与对策

| 风险 | 对策 |
|---|---|
| 环路（A↔B、自订阅）烧 token | 链深硬守卫 + 静态自订阅拒绝（§8） |
| 链式爆发挤占全局队列（容量 10）饿死他人 | 已知风险记录；`triggerQueueMaxPending` 可配；v2 再议按事件类型分级 |
| payload 泄露（跨用户订阅读他人执行内容） | 属主硬守卫（§4.2），候选集约束双保险 |
| 转录读取失败 | text 置空兜底，emit 不阻塞终态落库 |
| 存量 system 事件权限收窄引入回归 | 按 name 分流实现，feedback.created 路径零改动；e2e 第 8 项覆盖 |
