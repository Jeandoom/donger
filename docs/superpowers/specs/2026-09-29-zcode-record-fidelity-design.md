# zcode 引擎轮次记录保真修复设计

- 日期：2026-09-29
- 状态：待拍板（未动码）
- 背景：生产会话 7f25716e（zcode 引擎，6972.5k tok / 23m36s）记录不完整排查结论的修复方案
- 关联：specs/2026-09-25-zcode-engine-integration.md、495e175（transcript 反查）、2026-09-28 附件物化轮遗留「zcode 审计 input 回填」

---

## 1. 问题实锤（2026-09-29 生产库核验）

同一轮对话，三方数据对照：

| 数据面 | anthropic 引擎（对照会话 b4967f9f） | zcode 引擎（7f25716e） |
|---|---|---|
| messages 表 | 48 条（逐段叙述均落库） | **2 条**（提问+最终结论） |
| audit text 事件 | 47 | **1**（仅 turn.completed 的 response） |
| audit llm_input / llm_output | 68 / 167（逐轮） | **1 / 1**（全轮聚合） |
| audit tool_use.toolInput | 完整命令 JSON | **全为 `{}`** |
| transcript_entries | 386 行 | **0 行** |
| tool_use↔tool_result | 67/67 | 66/**62**（4 条 result 缺失） |

数据本体未丢：zcode 自有库 `data/workspace/users/<uid>/.zcode-home/db.sqlite`（由 runner 以
`ZCODE_SESSION_DB_PATH` 重定向，zcode-agent-runner.ts:151）中该会话（sess_46cd1078）存有
63 messages / 281 parts（47 text + 54 reasoning + 66 tool + 57 step）+ tool_usage 66 条带真入参。

## 2. 已验证事实（方案前提，均经生产数据实证）

1. **协议 toolCallId == zcode part.callID，1:1 零偏差**（66/66 全配对）→ 按 toolUseId 回填是精确 JOIN，无需模糊匹配。
2. **4 条缺失的 tool_result 在 zcode 库里全部是 `state.status="error"`** → 协议层 `tool.updated{kind:error}` 事件未达宿主（形状待实施时抓包确认），reconcile 兜底即可闭合，不必阻塞在协议修复上。
3. **audit tool_result 行的输出在 `toolOutput` 列**，tool_use 行的 `toolInput` 为 `{}`——回填只动这两列。
4. **resume 复用同一 sessionId**（session/send 发往 `opts.resume ?? sessionId`，zcode-agent-runner.ts:248）→ 同一会话多轮 parts 持续追加，对账必须按「本轮时间窗」切片，否则历史轮重复入库。
5. **sdkSessionId 即 zcode sessionId**，session_init 到达即回写指针（orchestrator.ts:823-840）→ orchestrator 在轮末持有准确的 zcode 库定位。
6. `step-finish` part 携带逐步 tokens（`{input,output,reasoning,cache.read/write}`）→ 具备做逐轮 LLM 审计的数据源（P2）。
7. `MessageStore.add` 无 createdAt 参数、`listByConversation` 仅按 `createdAt ASC` 排序、add 副作用刷新 conversations.updatedAt（message-store.ts:29-68）→ 补录必须回填时间戳，否则 46 段叙述全部排在结论之后且同毫秒乱序。

## 3. 架构：三引擎「轮次记录保真契约」

不被 zcode 场景固化：先定义所有引擎 runner 应满足的记录契约，zcode 缺口按级补齐，claude 为参照实现。

| 级别 | 契约 | claude | codex | zcode 现状 |
|---|---|---|---|---|
| P0 | 最终回复落 messages + 聚合 usage | ✓ | ✓ | ✓ |
| P1 | 中间叙述文本逐段落 messages（刷新后可回放） | ✓（逐块 text 事件） | ✓（claude-agent-runner.ts:307 / codex-agent-runner.ts:358 同款） | ✗ 仅 SSE 直播 |
| P1 | 工具调用审计带真实入参/出参 | ✓ | ✓ | ✗ input 空、4 条 error result 丢失 |
| P2 | 指针丢失可经 transcript 反查自愈 | ✓（SDK 实时 append） | ✗（同为 0 行，顺带受益） | ✗ |
| P3 | 逐轮 LLM 审计（llm_input/llm_output 粒度） | ✓ | 部分 | ✗ 仅聚合 |

## 4. 修复设计

### M1 轮末对账器（P1 核心，新模块）

新文件 `src/orchestrator/zcode-record-reconciler.ts`，导出
`reconcileZcodeRound(deps, input)`。调用点：**orchestrator.ts 的 `bridgeEvents` 返回之后、
aborted 早退之前**（orchestrator.ts:885 附近），守卫 `opts.llm.sdkType === "zcode" && conversation.sdkSessionId`，
整体 try/catch——对账失败只打日志，绝不影响回合结果。

```
input = {
  zcodeDbPath,        // join(opts.workspaceRoot, ".zcode-home", "db.sqlite")
  sessionId,          // conversation.sdkSessionId
  conversationId, userId, taskId,
  windowStartIso,     // 本轮开始时间（orchestrator 已有 turnStartMs）
  finalResponse,      // last(result).result，用于去重
}
deps = { messageStore, auditStore }
```

处理流程（单次 readonly 打开 zcode 库，读完全关）：

1. **取窗口**：`part.time_created >= windowStart - 1s` 且 `session_id = sessionId` 的 parts，
   连接 message 表取 role（**跳过 user**）。
2. **补录中间叙述**：对每个 assistant text part——
   - 跳过 `text === finalResponse`（末条已由 turn.completed 常规路径落库）；
   - 跳过与既有 messages 完全同文的行（幂等双保险，见 4）；
   - `redactSecrets()` 后经 messageStore 落库（role=bot，taskId 归属本轮），
     **createdAt 回填 part.time_created**；
   - 同步补一条 audit `text` 事件（对齐 claude 的 text 审计粒度）。
   - reasoning parts 不落消息（与 claude 口径一致：思考只直播+随 llm_output 进审计）。
3. **回填工具入参**：`UPDATE audit_events SET toolInput = ?`
   `WHERE conversationId=? AND type='tool_use' AND toolUseId=? AND (toolInput='{}' OR toolInput IS NULL)`，
   值 = `part.state.input` 序列化。
4. **合成缺失 result**：对 zcode 库 `state.status='error'` 而 audit 无 tool_result 行的 toolUseId，
   INSERT audit `tool_result` 行（isError=1，toolOutput=state.error/output，seq 取当前 max+1）。
5. **写对账标记**：audit 追加一条 `type="zcode_reconcile"` 事件（text=统计 JSON）。
   **幂等主键**：重入时发现本轮已有标记则整步跳过——双跑不产生重复消息。

### M2 MessageStore 端口微扩展（P1 前置）

`ports/message-store.ts` 的 `add` 增加可选尾参 `opts?: { createdAt?: string }`：
- sqlite 实现：INSERT 使用传入值，**conversations.updatedAt 仍刷为墙钟 now**（防会话在列表里因回填旧时间沉底）；
- in-memory 实现同步补齐；现有调用方零改动（不传即现状）。

### M3 transcript 反查覆盖 zcode（P2）

orchestrator session_init 分支（orchestrator.ts:823）在指针回写成功后，对 `sdkType==="zcode"`
追加一条 transcript 指针条目：
`transcriptStore.append({projectKey: user.id, sessionId, subpath:""}, conversationId, [{type:"zcode_session", timestamp}])`。
`latestSessionForConversation` 反查（runtime-manager.ts:347）即天然覆盖 zcode 指针丢失场景。
不做 281-parts 全量镜像（zcode-home 本身就是全保真转录，重复落一份只增维护面）；
`runtime-manager.ts:609` 的 transcript load 对 zcode 会话仍返回 null，作为已知边界记录。

### M4 配套（P2，按拍板取舍）

- **被杀轮补录**：restart-sweep（orchestrator/restart-sweep.ts）标 failed 时，对
  `llmSdkType='zcode'` 且有 sdkSessionId 的任务调 reconcileZcodeRound（无 finalResponse，
  窗口=任务创建时刻起）——被重启杀掉的轮也能留下已流出的叙述与工具痕迹。
- **逐轮 LLM 审计**：由 step-start/step-finish parts 合成 audit `llm_output` 行
  （tokens/durationMs/该步文本），LLM 观测页对 zcode 从 1 行变 57 行。llm_input 无请求体数据源，不伪造。
- **存量回填**：一次性脚本 `scripts/backfill-zcode-records.ts`（tsx 直跑，admin 手动执行）：
  遍历 `llmSdkType='zcode'` 的会话逐任务对账（幂等标记保证可重跑）。跑不跑生产由用户定。

## 5. 灰度与回退

- 环境开关 `DONGER_ZCODE_RECORD_RECONCILE=off` 一键关闭对账（默认开）；
- 对账路径全部 try/catch + 日志，故障面=「记录变薄回到现状」，不影响对话功能；
- 存量脚本只 INSERT/UPDATE 补缺，不改不删既有行，可重复执行。

## 6. 测试计划

1. **单测（fixture 假 zcode 库）**：临时 sqlite 按 zcode schema 造 parts（含 user/末条 response/error 工具/跨轮窗口外数据），断言：叙述补录顺序与回填时间戳、response 去重、user 跳过、脱敏生效、toolInput 回填 SQL 命中数、缺失 result 合成、**重复执行幂等（标记生效）**。
2. **端口单测**：add 带 createdAt 时 conversations.updatedAt 仍为 now；不传时行为不变。
3. **runner 回归**：zcode-agent-runner 既有测试全绿；mapSessionEvent 不改（对账不侵入协议映射）。
4. **真机冒烟（dev 3300，zcode agent）**：提问一轮 → messages >2 且顺序正确、刷新页面回放完整、audit toolInput 非空、钉钉通道无补录刷屏（补录仅落库不推送）。
5. 提交前 `tsc` 全量（vitest 不做类型检查，铁律）。

## 7. 工作量与拍板点

工作量：M1+M2+M3 ≈ 1～1.5 人日（含单测）；M4 三项合计 ≈ 1 人日。

| # | 决策点 | 建议 |
|---|---|---|
| ① | 中间叙述只补 text（推荐，对齐 claude）还是 reasoning 也留档（仅审计） | 只补 text |
| ② | M4 逐轮 LLM 审计做不做 | 做（数据现成，观测页价值大） |
| ③ | M4 被杀轮补录做不做 | 做（直接缓解 09-28 重启杀轮的记录损失） |
| ④ | 存量回填脚本：交付手动跑（推荐）还是直接对生产跑 | 交付脚本，用户自行择时 |
| ⑤ | transcript 指针条目：仅 zcode（推荐）还是三引擎统一 | 仅 zcode，codex 另议 |
