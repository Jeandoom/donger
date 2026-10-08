# 引擎会话生命周期契约（三引擎统一）

- 日期：2026-10-08
- 状态：已实施（随本轮修复上线）
- 事故：2026-10-08 生产两起故障（§0）；本契约是根因分析的设计层产出，五项条款是后续所有引擎接入与排障的对照基准。

## 0. 事故记录（根因链压缩版）

| # | 现象 | 根因 |
|---|------|------|
| A | 会话 375b7802 重发问题报 `Session not found: sess_a0e22200` | 10-01 被重启杀掉的轮在 session_init 时已把**一次性 create id** 即时回写进会话指针；该 id 从未被 zcode 持久化，resume 硬失败。两道自愈全漏：B0 反查只救空指针（`runtime-manager.ts` `!resumeSessionId`）；过期重试正则只匹配 claude 文案 |
| B | 会话 e0e63681「部署在homedb」任务 running 挂死 40+ 分钟，zcode 侧 4 分钟就跑完了（db.sqlite turn=completed 实锤） | runner 对 create id 订阅、向 resume 目标发送；新 CLI 按会话绑定严格投递事件 → 轮事件全盲，turn.completed 永不到达。生产看门狗关闭（`TURN_STALL_TIMEOUT_MS=0`）且无轮级兜底 |

触发器：ZCode 桌面版 10-01 上午自动更新（session id 格式裸 UUID→`sess_` 前缀同日翻转），生产行为随之改变；而 resume 路径自 10-01 后直到 10-08 才首次被真实流量踩到。

## 1. 实证基础（zcode.cjs bundle 反解 + 生产证据）

- `Session not found: ${t.sessionId}` 抛自 `wRn`（activateSessionForResume）：会话不在内存注册表且**无持久化记录**时硬失败。
- resume 只把旧会话激活进**服务端**注册表（`e.sessions.set`），不改变调用连接的会话绑定。
- 事件分发 `kXa`：`if (String(n.sessionId) !== t.app.sessionId) { v4Gateway.ingestDetachedLiveSession(...); return }` —— 与绑定会话错位的事件进 detached 网关，**不作为 `session/event` 通知投递**。
- `session/subscribe`（HKo）= 对指定会话设 deliveryKind + `afterSeq` 重放，是「迟到附着」的协议正路；订阅必须晚于 resume（会话激活是 subscribe 查找的前置）。
- zcode 会话**懒持久化**：生产实证 session/create 后被杀的轮在 db.sqlite 留不下任何 session 行。
- 生产对照：非 resume 轮（订阅==发送目标）事件全量到达；resume 轮（订阅≠发送目标）零事件。

## 2. 契约条款

### C1 持久化时机（何谓「会话存在」）

- **条款**：指针指向的会话 id 必须在引擎侧已持久化；引擎必须声明「什么时刻起会话可被下一轮 resume」。runner 不得假设 create 返回即持久。
- zcode：首个消息/轮数据落库后才可 resume；被杀轮可能零痕迹。claude：sessionStore 实时 append，session_init 即持久。codex：thread 落盘，暂不覆盖（历史决策）。

### C2 id 语义（谁是干活会话）

- **条款**：每轮恰有一个「干活会话 id」= `resume 目标 ?? create 返回值`。`session_init` 事件必须上报干活 id；会话指针（`conversations.sdkSessionId`）只允许存干活 id；create 的返回值在 resume 轮里仅是协议握手产物，**禁止**入库、订阅或上报。
- 三引擎对照：claude session_init 的 id 即干活 id（天然满足）；zcode 修复前三处各按不同假设行事（订阅 create id / 发送 resume id / 回写 create id），修复后统一为干活 id。

### C3 错误分类（引擎报错 → 语义）

- **条款**：「指针指向的会话不可恢复」必须被识别为统一语义并触发恢复流程（清指针 → 不带 resume 重新 prepare → 全新会话），不得依赖单一引擎的报错文案。
- 现状实现：orchestrator `SESSION_EXPIRED_RE` 覆盖 claude（`No conversation found with session ID`）与 zcode（`Session not found:`）两族文案；runner 侧后续演进方向是把引擎错误映射为结构化错误码，正则收敛进 runner。
- B0 transcript 反查只救「空指针」；「坏指针」（非空但指向不存在/未持久化会话）由本条的重试兜底。两者职责互补，缺一不可。

### C4 事件投递（订阅对齐）

- **条款**：runner 订阅的会话必须与实际执行轮任务的会话一致；订阅时机在 resume 之后。引擎若按会话严格投递事件，订阅错位 = 轮事件全盲（不是降级，是全盲）。
- zcode 修复后顺序：`create → resume（如有）→ subscribe(干活 id) → send(干活 id)`。claude 由 SDK 内部管理，不适用。

### C5 超时责任（谁兜底挂死）

- **条款**：任何引擎的轮都必须有至少一层活跃超时兜底；全局看门狗关闭时，引擎层必须自带。
- 现状：全局看门狗（`TURN_STALL_TIMEOUT_MS`）因 claude AskUserQuestion 问询竞态在生产保持关闭；zcode runner 内置**轮级事件停摆守卫**（`DONGER_ZCODE_EVENT_STALL_MS`，默认 600_000ms，0=关闭；AskUserQuestion 挂起豁免）。停摆即显性 fail 本轮，队列不堵。
- 已知取舍：超长静默工具调用（>10min 无任何 tool 事件的 Bash 等）会被误判，属于「显性失败可重试」优于「无限挂死」的显式选择。

## 3. 修复映射

| 契约 | 修复 | 位置 |
|------|------|------|
| C2 | session_init 上报干活 id | `zcode-agent-runner.ts` 会话建立段 |
| C4 | 订阅移到 resume 之后、对准干活 id | 同上 |
| C3 | 过期重试正则加 zcode 文案 | `orchestrator.ts` SESSION_EXPIRED_RE |
| C5 | zcode 轮级事件停摆守卫 | `zcode-agent-runner.ts` 事件泵 |
| C1/C2 | 指针语义不变，源头不再产生坏指针 | —（存量坏指针由 C3 重试兜底） |
