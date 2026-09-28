# 事件触发器设计：反馈模块 feedback.created 触发（spec，待拍板）

- 日期：2026-09-28
- 状态：设计稿（5 拍板点已全部裁决，见 §11），未实施、未提交
- 关联：触发器现状（`src/domain/trigger.ts` / `src/orchestrator/scheduler.ts` / `src/orchestrator/hook-registry.ts`）、反馈模块（spec 2026-09-20-feedback-module-design）、通知模块（spec 2026-09-28-notification-module-design）

## 1. 需求与背景

反馈模块已有完整闭环（提交→回复→状态流转），但「新反馈产生」只落在数据库和站内信里，无法驱动自动化。需求：触发器新增「反馈」类型，当反馈模块新增反馈内容时触发绑定的循环任务（如：自动分类打标、生成回复草稿、同步到外部工单）。

现有触发器两类型：
- `scheduler`：cron 定时，主动**拉**源（http/file），matcher 判定后 fire；
- `hook`：外部系统 **推** HTTP 到 `/hooks/<slug>`，matcher 判定后 fire。

## 2. 架构定位（先抽象，场景只当验收样板）

触发源本质是三种形态：

| 形态 | 类型 | 发起方 | 现状 |
|---|---|---|---|
| pull | scheduler | 平台 cron 定时拉 | 已有 |
| push（外部） | hook | 外部系统 HTTP | 已有 |
| **push（进程内）** | **event** | **平台内部模块发事件** | **本次新增** |

即本次不做「feedback 专用触发器」，而是补齐第三形态：**进程内事件触发**。事件投递管线（查订阅触发器 → matcher 判定 → fire 绑定 loops）一次落地，未来 KB 变更、会话完结、审批到期等内部事件全部复用，场景只注册事件名。反馈是第一个事件生产者。

## 3. 领域模型（`src/domain/trigger.ts`）

```ts
export const EVENT_TRIGGER_NAMES = ["feedback.created"] as const;   // 事件名注册表，后续追加
export type EventTriggerName = (typeof EVENT_TRIGGER_NAMES)[number];

export const TriggerEventConfigSchema = z.object({
  name: z.enum(EVENT_TRIGGER_NAMES),
  matcher: TriggerMatcherSchema,          // 完全复用现有 8 种 matcher，零新增 kind
});
```

- `TriggerBaseSchema.type` 枚举加 `"event"`；`superRefine` 加一条「event 类型必须提供 event 配置」。
- **零迁移**：`sqlite-trigger-store` 的 config 本就是 JSON blob，`marshal`/`unmarshal` 各加一个 `event` 分支即可。

## 4. 事件 payload（sourceOutput 契约）

事件发生时把业务事实序列化为 JSON 作为 `sourceOutput`，与 hook body 同语义（同走 matcher、同经 `wrapUntrusted` 注入 prompt 模板）：

```json
{
  "event": "feedback.created",
  "feedback": {
    "id": "uuid",
    "category": "ui",
    "categoryLabel": "界面",
    "status": "open",
    "content": "≤2000 字原文",
    "submitterId": "…",
    "submitterName": "…（userStore 解析，查不到降级 submitterId）",
    "imageCount": 2,
    "createdAt": "ISO"
  }
}
```

matcher 示例（全用现有 kind）：`jsonPathEq $.feedback.category = "feature"` 只触发功能类；`bodyContains "导出"` 关键词过滤；`always` 全量。payload 由**发射方**（web-channel）构建——发射方拥有 payload 契约，dispatcher 只认 opaque 字符串，与 hook 完全同构。

## 5. 投递管线（持久化队列 + 泵，裁决⑤：排队不丢）

```
POST /api/feedback（创建成功后）
  └─ void eventTriggers.dispatch("feedback.created", payloadJson)   // fire-and-forget，fail-open
        ├─ triggerStore.listAll() → filter type==="event" && event.name===name
        ├─ evaluateMatcher(matcher, { body: payloadJson })          // 复用现有判定
        └─ 命中者（owner 级 workflows ∩ loops(enabled)）逐 loop：
             queueStore.enqueue({ loopId, payload })                // 先落库（容量上限内永不丢）
             └─ void loopRunner.pump(loopId)
```

### 5.1 队列（新 port `TriggerQueueStore` + `sqlite-trigger-queue-store.ts`）

```sql
CREATE TABLE IF NOT EXISTS trigger_queue (
  id TEXT PRIMARY KEY, loopId TEXT NOT NULL, triggerId TEXT NOT NULL,
  eventName TEXT NOT NULL,          -- 溯源：事件名 / hook 路径 / 'scheduler'
  payload TEXT NOT NULL,
  status TEXT NOT NULL,             -- pending | running | done | dropped
  error TEXT,
  createdAt TEXT NOT NULL, startedAt TEXT, finishedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_trigger_queue_loop ON trigger_queue(loopId, status, createdAt);
```

方法：`enqueue`（容量上限检查）、`claimNextPending(loopId)`（事务内取最旧 pending→running，单 loop 至多一条 running）、`markDone(id)`、`countPending(loopId)`、`resetStaleRunning()`（重启时 running→pending）、`deleteByLoop(loopId)`、`cleanupBefore(date)`。

### 5.2 泵（`LoopRunner.pump`）

`fire(loopId, payload, eventName)` 语义改为 **交付=入队+唤醒泵**，不再直接跑、不再 skip：

```
pump(loopId):
  if pumping.has(loopId) return      // 已有泵在抽水，它收尾时会看到新行
  pumping.add(loopId)
  while (row = claimNextPending(loopId)):
    await runOnce(loopId, row.payload)   // 既有主链路：属主复核/unattended/wrapUntrusted/run 记录/站内信
    markDone(row.id)                     // 行状态=交付结果；运行成败由 loop_runs 承载，队列不做重试
  pumping.delete(loopId)
```

- **队列是交付层不是重试层**：runOnce 内部自捕获失败（run 记 failed+站内信），行照常 done——避免对永久失败的 loop 无限重投。
- **at-least-once**：进程在 runOnce 中途崩溃 → 重启时 `running→pending` 重投，可能重复执行一次（无人值守自动化的标准取舍，文档写明）。
- **重启恢复**：`restore()` 先 `resetStaleRunning()`，再对每个有 pending 行的 enabled loop `pump`；顺带 `cleanupBefore(now-7d)` 清理终态行。
- **统一三种触发类型**：泵放在 LoopRunner 交付层，scheduler/hook 的 fire 同走此路径——hook 与 cron tick 从「忙时丢事件」变为「忙时排队」，同一潜在缺陷一并修复。
- **联动点**：loop 重新启用（PATCH enabled=true）时调 `pump` 抽积压；删除 loop 时 `deleteByLoop` 级联清行；loop 详情返回体附 `queuedCount`（前端「排队中 N」展示）。
- **不阻塞主流程**：dispatch 在反馈 201 响应路径之外异步执行，任何异常只记日志，反馈提交永不因触发器/队列失败而失败。
- **零注册/零刷新**：事件发生时实时查库（与 hook 同构），trigger 增删改即时生效；`SchedulerService` 仅在 `restore()` 追加队列恢复调用，注册逻辑不动。

## 6. 权限与安全

- **唯一新增风险 = 跨用户反馈内容泄漏**：反馈可见性是 admin 全量 / member 仅本人；若允许 member 建 event 触发器，他人反馈正文会被注入其 agent prompt。**M1 收口：`event` 类型触发器的创建/编辑仅 admin**（web-channel 的 POST/PUT /api/triggers handler 内校验 `viewer.role === "admin"`，否则 403；路由守卫表不变，仍 authenticated）。
- member 侧「我的反馈被回复」诉求已由通知模块 `feedback.replied` 站内信覆盖，不属触发器场景（触发器是无人值守自动化，不是提醒）。
- 继承防线（零新增）：反馈正文是用户自由文本=提示注入面，`loop-runner` 已对 sourceOutput 做 `wrapUntrusted("trigger-source")` 定界；无人值守强制 ask-before-change 挡住静默变更。
- 风暴面：反馈创建已有限流（10 条/小时/用户）；单条反馈 fire 所有命中 loop，loop 忙时跳过（见 §7）。

## 7. 容量上限与溢出（排队不丢的边界）

- 单 loop pending 行数上限 `TRIGGER_QUEUE_MAX_PENDING`（env，默认 200）：入队超限时新行落为 `dropped`（保留事件名与原因，不执行），并给 loop 属主发一条站内信「触发队列已满，事件被丢弃」（dedupeKey=loop+日期防刷屏）。**上限是防 DoS 的显式边界：不静默丢（溢出有记录有告警），也不无上限堆积打爆磁盘/内存。**
- 正常风暴面已被既有限流压制：反馈 10 条/小时/用户；cron 高频+慢 loop 的积压同样由上限兜底（每 tick 一行，200 行=约 3 小时余量）。
- matcher 过滤（只订阅特定类别/关键词）仍是第一降噪手段：不匹配的事件在入队前就被丢弃，不占队列。

## 8. 测试与调试

- `LoopRunner.testTrigger` 加 event 分支：合成一条样例 payload（固定 fixture 反馈）跑 matcher，返回 matched/debug——编辑页「测试」按钮对 event 类型有意义，无需真实造反馈。
- 测试清单（镜像 hook-registry 既有测试形态）：
  1. schema：event 触发器 roundtrip；缺 event 配置被 superRefine 拒；未知事件名被拒。
  2. store：trigger 表 marshal/unmarshal 含 event 分支（零迁移验证）；queue 表 enqueue/claim/markDone/上限/重启恢复。
  3. dispatcher：命中→逐 loop 入队且 payload 原样；不命中→不入队（不占队列）；loop disabled→不入队；fire 抛错→仅日志不影响调用方。
  4. 泵：忙时入队不 skip、runOnce 返回后自动抽下一行；FIFO 顺序；单 loop 无并发 run；溢出→dropped+站内信；删除 loop 清行；重新启用抽积压。
  5. handler：member 创建/编辑 event 触发器 403；admin 放行；反馈创建在触发器抛错时仍 201。
  6. testTrigger：event 分支合成 payload + matcher 判定正确。
- 可观测：run 记录 `triggerOutput` 存完整 payload；审计/站内信全部走既有 loop 通道。

## 9. Web UI（`TriggerEditorPage.tsx`）

- 类型下拉加第三项「事件（event）」。
- event 区块：事件名下拉（当前仅 `feedback.created`＝「新反馈提交」，后续事件名追加即自动出现）+ **复用现有 matcher 编辑器**（无任何新 matcher UI）。
- WorkflowsPage / LoopsPage 零改动（trigger 引用已通用）。
- 事件名中文标签与 `EVENT_TRIGGER_NAMES` 两端语义一致（沿用反馈类别标签的共用模式）。

## 10. 改动清单与估算

| 文件 | 改动 | 规模 |
|---|---|---|
| `src/domain/trigger.ts` | event 配置 schema + type 枚举 + refine + 事件名注册表 | +25 行 |
| `src/adapters/sqlite-trigger-store.ts` | marshal/unmarshal 各加 event 分支 | +6 行 |
| `src/ports/trigger-queue-store.ts` | 新 port | ≈25 行 |
| `src/adapters/sqlite-trigger-queue-store.ts` | 新适配器（建表/enqueue/claim/markDone/reset/cleanup） | ≈90 行 |
| `src/orchestrator/event-trigger-dispatcher.ts` | 新文件（仿 HookRegistry：matcher→入队→pump） | ≈50 行 |
| `src/orchestrator/loop-runner.ts` | fire 改交付语义 + pump + testTrigger event 分支 | ≈+55 行 |
| `src/orchestrator/scheduler.ts` | restore() 追加队列恢复调用 | +5 行 |
| `src/adapters/web-channel.ts` | deps 注入 + POST /api/feedback 发射 + POST/PUT /api/triggers admin 校验 + loop 启停/删除联动 + queuedCount | ≈+40 行 |
| `src/index.ts` | 装配 dispatcher 与 queue store | +5 行 |
| `web/src/pages/TriggerEditorPage.tsx` | 类型选项 + event 区块 | ≈40 行 |
| `web/src/pages/LoopDetailPage.tsx` | 「排队中 N」展示（可选，小） | ≈10 行 |
| 测试 | schema/两 store/dispatcher/泵/handler/testTrigger | ≈300 行 |

估算 1–1.5 人日（队列是主要增量）。**不动**：hook 路由与 matcher、loop-runner 主执行链路（runOnce 内部）、路由守卫表、既有表 schema（仅新增 trigger_queue 表）。

## 11. 拍板点（已全部裁决 2026-09-28）

1. **抽象粒度**：✅ 泛化 `event` 类型+事件名注册表（未来事件零管线成本）。
2. **权限**：✅ M1 admin-only 创建（收口跨用户反馈泄漏）。
3. **事件范围**：✅ M1 仅 `feedback.created`（replied 的提醒诉求通知模块已覆盖）。
4. **testTrigger**：✅ 合成样例 payload 跑 matcher。
5. **忙碌语义**：✅ **改为持久化队列，不跳过不丢失**（§5/§7）；hook 与 scheduler 忙时同样从丢事件变为排队；上限+溢出告警为防 DoS 的显式边界；崩溃恢复按 at-least-once 重投。
