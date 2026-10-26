# 会话分叉（fork）功能设计

> 2026-10-23 设计稿；2026-10-26 五拍板齐备（见 §12），M1 已随本分支实施（测试/tsc/web build 全绿）。目标：在任意消息处将对话派生为一条独立新会话，原会话零扰动。
> 社区参照：Open WebUI「Fork chat」、LibreChat「Forking Chats」、LobeChat 分支对话、Claude Code `--fork-session`（见 §2）。

## 0. 一句话

分叉 = **会话的派生（derive）操作**，由三层既有能力的组合构成——平台层消息快照复制（messageStore 行拷贝）＋ 引擎层会话续接（**统一契约、原生优先**：claude 走 SDK 原生 `forkSession`；zcode/codex 无原生能力时以「新会话＋注入继承历史」降级模拟）＋ 沙箱层工作树续接（worktree 基点改指源会话分支）。血缘用 conversations 两个可空列表达，**不建新表、不建消息树、不引入新子系统**。

## 1. 背景与动机

三个真实使用场景（也是社区产品做分叉的公共动机）：

1. **换方向重试**：某轮答偏了/做砸了，想从更早的位置换一种问法重来，但又不想丢掉原会话的过程记录。
2. **并行探索**：一个会话推进到某阶段后想同时试两条路（如两版实现、两种方案），互不污染。
3. **安全试验**：Claude Code 社区总结的典型用法——fork 出一个副本做有风险的尝试，主线保持干净。

现状缺口的实锤（代码调研 2026-10-23）：

- 会话层**没有任何 clone/copy/fork/derive 功能**（全库检索仅命中 git worktree 与 skill slug derive）。
- Web 端**不存在消息级操作菜单**（无复制/重试/编辑/分叉入口）；会话项菜单只有「删除」。
- 最接近的先例是 agent 复制（`POST /api/agents/:id/duplicate`，`web-channel.ts:5400`）与 KB 复制（`/api/kb/:id/duplicate`）——「派生资源、血缘弱关联、凭证类内容不随复制」的平台既有心智。

## 2. 社区方案调研

| 产品 | 范式 | 机制要点 |
|---|---|---|
| ChatGPT / Claude.ai | 会话内消息树 | 编辑/重发历史消息产生**同会话内**兄弟分支，UI 提供分支切换箭头 |
| LibreChat | 消息树 ＋ fork 双轨 | 每条消息带 `parentMessageId` 构成树，编辑产生兄弟分支；另支持从任意消息 fork 成新聊天（可选携带哪条分支、多少历史） |
| LobeChat | 分支对话 | 在任意消息处创建新对话分支，社区讨论（#4717）明确否决了显式树状结构，选择「分支即新对话」 |
| Open WebUI | fork-to-new-chat | 从任意消息 fork 出独立新聊天（含此条/不含此条两档），保留 folder/pin/tags/变量；被分享的只读会话也可 fork |
| Claude Code | 引擎级会话克隆 | `--resume <id> --fork-session` ＋ `/branch`：复制转录到**新 session id** 后分叉，原会话不动；Agent SDK 进一步提供 `forkSession(sessionId, { upToMessageId, sessionStore })` |

**结论**：两条技术路线——

- **路线 A（消息树）**：消息间建立 parent 链，分支活在同一会话里。交互最华丽，但要求存储、流式、审计、反馈、事件全链路按树语义重构；且 donger 的引擎会话是**线性 transcript**（sdkSessionId 单指针续跑），树形切换与引擎续跑语义直接冲突。成本全平台级，收益集中在演示层。
- **路线 B（fork-to-new-chat）**：分叉点之前的历史快照进新会话，两侧此后独立演进。与会话为一等单元的现有架构（conversations/messages/worktree/GC/软归档全部按会话组织）零冲突，Open WebUI / LobeChat / Claude Code `/branch` 均收敛于此。

**拍板建议：路线 B。** 消息树不排除在远期（M3 之后），但不在本方案内。

## 3. 架构：分叉是三层能力的组合

按平台既有抽象逐层落位（符合「复用既有抽象，勿平行造新子系统」的原则）：

```
┌─ 平台层：消息快照复制 ────────────────────────────────┐
│  messages 行拷贝（新 id、原 createdAt、taskId 置空）    │
│  conversations 新行 ＋ 血缘两列（forked_from_*）        │
│  附件引用共享（不复制文件，同属主 /uploads 直读）        │
├─ 引擎层：会话续接（统一契约，原生优先）────────────────┤
│  不变量：一个 sdkSessionId 任意时刻只归一个活跃会话      │
│  统一契约：RunOptions.forkFrom={sessionId,upToMessageId?}│
│  claude：SDK 原生 forkSession（sessionStore 落 SQLite）  │
│  zcode/codex：无原生 fork → 降级「新会话+注入继承历史」  │
│  （注入复用 wrapUntrusted + conversation-mention 管线）  │
├─ 沙箱层：工作树续接 ──────────────────────────────────┤
│  新会话 worktree 基点覆盖为源会话分支                    │
│  donger-session/<srcConvId>（缺失则回退标准基点）        │
└──────────────────────────────────────────────────────┘
```

各层全部落在既有机制上：复制走 messageStore 既有 `add(opts.createdAt)` 回填通道；历史注入走 `wrapUntrusted`（`src/domain/untrusted-content.ts:31`）与 mentions 管线同款形态（审计可见 `untrusted source="conversation:…"` 块）；worktree 走 `sessionWorktreeReposRoot` 路径约定，仅给 `resolveBaseRef`（`git-cli-repository-materializer.ts:235`）加一个基点覆盖入口；引擎克隆用 claude SDK 已内置、donger 尚零消费的 `forkSession`（`sdk.d.ts:738`，支持 `sessionStore` 与 `upToMessageId`）。

**否决「共享 sdkSessionId 懒分叉」**（fork 两侧先共用原 session、首发消息时才克隆）：三引擎 resume 语义不一（codex/zcode 无 fork），懒分叉要处理「源会话先行发言」的竞态与 transcript 写冲突，复杂度全在异常路径上。「原生优先、注入兜底」让正常路径永远简单：**分叉会话的 sdkSessionId 从创建起就是空串**（引擎层原生 fork 在分叉会话首次发消息时才物化出自己的新 session id 并回写）。

## 4. 数据模型

### 4.1 conversations 幂等补列（沿用既有补列模式）

| 列 | 类型 | 语义 |
|---|---|---|
| `forkedFromConversationId` | TEXT NULL | 血缘：源会话 id；NULL = 非分叉 |
| `forkedFromMessageId` | TEXT NULL | 血缘：分叉点消息 id（含此条语义时即该条；不含则为其前一条） |

不存 forkedAt（新会话 createdAt 即分叉时刻）。补列走 `sqlite-conversation-store.ts` 既有 `ensure*Column` 幂等模式，领域类型 `ConversationSchema` 加两个 optional 字段。

### 4.2 复制清单

**随分叉复制**：

| 项 | 处理 |
|---|---|
| messages（role/text/files/createdAt） | 逐行拷贝，**生成新消息 id**，createdAt 保留原值（走 `add` 的 `opts.createdAt`，保序）；`taskId` 置空（旧 taskId 指向源会话运行，保留会造成活动/取消关联错配） |
| agentId / kbId / permissionMode / lastModelRef / llmSdkType | 原样复制（llmSdkType 复制保证引擎一致性守卫 `sdkTypeMismatch` 语义不漂移） |
| title | `<源标题> · 分叉`，创建时即为终态；**豁免 maybeAutoTitle**（`orchestrator.ts:1999`，实现时核对其触发条件并加分叉豁免） |
| channelId | 固定 `"web"`（分叉是 Web 功能；钉钉来源会话分叉出的新会话只在 Web 侧，源会话通道不受影响） |
| 附件 | **不复制文件**。`files` JSON 里的绝对路径本就落在属主 homeDir 下（`resolveAttachmentDir`，`web-channel.ts:7766`），分叉发起人=源属主（见 §7 守卫），`/uploads/<srcConvId>/…` 回读校验「上传者=会话属主」天然通过。文件浏览器 tab 显示新会话自己的 attachments 目录（分叉后新上传归新会话），属预期行为 |

**明确不复制**（附理由）：

| 项 | 理由 |
|---|---|
| sdkSessionId | 核心不变量：新会话必须空串，否则会 resume 进源会话引擎线程 |
| 反馈关联（feedback_items.conversationIds） | 会话粒度弱指针，指向源会话是正确语义；分叉不产生反馈副本 |
| workflow_runs / 通知轮 | 运行记录以源会话为准，分叉是快照不是续跑 |
| activity/events（审计事件流） | 以会话为单位组织，不复制；分叉会话的活动从第一条新消息开始记 |
| 消息上的变更 chips / 工具调用 | 前端从 events/activity 提取（`fileChanges.ts`），源数据不复制则自然不显示，无残留 |
| 通知偏好 / 侧栏星标 | 用户级或工作流级配置，与单会话派生无关 |

### 4.3 批量插入的实现注意

`messageStore.add` 每次调用都会把 conversations.updatedAt 刷为墙钟（`sqlite-message-store.ts:69-73`）。N 条消息 = N 次 update，M1 可接受（单会话消息量级百条内）；若实测慢，在 store 内加一个 `addMany` 旁路（单事务批量插入＋末尾一次 updatedAt 刷新），属纯优化不改语义。

## 5. 引擎会话续接

### 5.1 不变量（新增，写进 orchestrator 注释）

**一个 sdkSessionId 在任意时刻最多归属一个活跃（未归档）会话。** 分叉是唯一会制造「血缘会话对」的操作，本设计通过「新会话 sdkSessionId 恒为空」保证该不变量永不被分叉破坏。

### 5.2 统一契约：原生优先（D1 拍板）

上层建模与交互全引擎统一——同一分叉入口、同一血缘模型、同一拒绝矩阵；引擎差异收敛在 runner 层。`RunOptions`（`src/ports/agent-runner.ts`）新增：

```
forkFrom?: { sessionId: string; upToMessageId?: string }   // 平台统一分叉契约
```

prepare 阶段检测到会话带 fork 血缘且 `sdkSessionId=''` 时填入（此时不传 resume）；轮末照常 `commit` 回写物化出的新 session id。

| 引擎 | 实现 | 切点能力 |
|---|---|---|
| claude | **原生**：`forkSession(sessionId, { upToMessageId?, sessionStore })`（`sdk.d.ts:738`），转录复制到新 session id、重映射 uuid 保留 parentUuid 链；`sessionStore=SdkSessionStoreAdapter` 使副本直接落 SQLite 而非本地文件 | 会话级全量 M1 即原生；中间精确切点待 message→transcriptUuid 映射（M2，`TranscriptRef.lastMessageUuid` 启用） |
| zcode | 协议仅 `session/create + session/resume`（`zcode-agent-runner.ts:371-395`），**无 fork——降级注入**（后续若协议补 fork 能力再切原生） | 降级 |
| codex | SDK 仅 `startThread/resumeThread`（`codex-agent-runner.ts:276-278`），**无 fork——降级注入**；直接复制 rollout 内部文件属赌未公开格式，否决 | 降级 |

降级引擎忽略 `forkFrom`（不传 resume），由 §5.3 注入承接——对上层完全透明：无论引擎走哪条路，分叉会话首轮之后模型都「知道」分叉前历史。

### 5.3 降级路径：注入继承历史（zcode / codex；M1 期 claude 中间切点暂同）

- 触发条件：发送消息时会话满足 `forkedFromConversationId ≠ NULL` **且** 该会话尚无 bot 消息（首个 agent 轮）。条件天然幂等——首轮成功后不再成立，重试首轮重复注入无害。
- 注入内容：从**分叉会话自身的已有消息**（即快照，与源会话后续演进无关）拼装「起始 → 分叉点（含）」的对话史，`wrapUntrusted(history, "conversation:<forkId> 分叉继承历史")`，挂在首轮 prompt 头部。
- 预算：独立常量 `FORK_HISTORY_MAX_MESSAGES = 500` / `FORK_HISTORY_MAX_CHARS = 100_000`（`src/domain/fork.ts`），超限取**尾部**（近端上下文价值高）；独立于 mention 100k 共享池，不挤占当轮引用预算。
- claude 中间切点在 M2 映射就绪后从注入切到原生 `upToMessageId`（切点精确且工具结果/文件上下文全保真）；注入路径继续作为无原生能力引擎的常驻兜底。
- 可观测：注入块带 untrusted source 标签，审计 prompt 可断言（复用会话资源引用的冒烟方法论）。

### 5.4 引擎会话文件

不复制、不清理（与现状一致）：源会话的 claude engine-state / codex rollout / zcode db.sqlite 原样保留；分叉会话的引擎态从自己的首轮开始生长。归档会话本就无引擎侧清理（软归档语义），分叉不改变这一现状。

## 6. 沙箱续接（worktree 基点覆盖）

- 会话级 worktree 路径按 convId 派生（`worktrees/<convId>/repos/<repo>`、分支 `donger-session/<convId>`），分叉会话天然获得独立工作树，无路径冲突。
- **基点覆盖**：`RuntimeManager.prepare`（`runtime-manager.ts:335-353`）读会话血缘，存在 `forkedFromConversationId` 时给 materializer 传 `baseRefOverride = donger-session/<srcConvId>`（先 `rev-parse` 验证存在）；`resolveBaseRef` 加一个可选覆盖参数，命中即跳过远端 HEAD 探测。**效果：分叉会话的文件初始状态 = 源会话在分叉时刻的已提交状态。**
- 回退链：源分支不存在（无 git agent / GC 已回收 / 从未建树）→ 静默回退标准基点（远端 HEAD 优先级不变）。
- **未提交变更：携带（零扰动快照，D3 落地口径）**。临时索引快照：`GIT_INDEX_FILE=<临时文件> git read-tree HEAD && git add -A && git write-tree` → `commit-tree`，生成「快照 commit 对象」作为新工作树基点——全程只创建 git 对象，**不触碰源工作区/索引/分支/提交历史，源会话零扰动**；未跟踪新文件一并带入。源会话忙时已被 409 守卫挡住，快照时点文件状态稳定。快照生成失败（锁竞争等）降级为分支 HEAD 基点并记审计备注。若拍板人后续改选「不携带/开关」，仅影响这一处基点取值，属小改动。
- **已知取舍**：文件快照反映的是**分叉执行时刻**的源状态（文件状态无法按历史消息回溯），与消息快照的分叉点时点可能不同；按消息回溯文件状态需逐消息快照，成本高，明确不做。
- GC 交互：源会话归档后 GC 回收其工作树与分支；分叉会话的树是独立 checkout 不受影响。源分支因未合并（分叉分支从它长出但 `-d` 只删已并入 HEAD 的分支）大概率留存，即使被回收也无碍。

## 7. API 设计

```
POST /api/conversations/:id/fork
  body: { messageId?: string }   // 缺省 = 整会话；给出时恒为「含此条」（D5）
  201 → { conversation: ConversationSummary, copiedMessages: number }
```

- **守卫**：登记 `web-route-guards.ts` 会话段（owner 规则，`access.kind:"owner"`，铁律：**新路由漏登记 = 404**）。语义沿用既有会话路由——非属主拒绝、admin 直通。会话层无分享语义，故「分杈权=属主权」自动成立，被分享 agent 的使用者本就看不到他人会话。
- **messageId 校验**：必须属于源会话，否则 409；复制范围恒为「起始 → 该条（含该条）」（D5 拍板，单档语义，无 inclusive 参数）。
- **拒绝条件**：
  - 源会话已归档 → 404（归档即用户不可见，与既有语义一致）；
  - 源会话有进行中轮次 → 409（进行中轮尚未落库，快照不完整；引擎克隆中途分叉亦不安全）；
  - 源会话 0 条消息 → 409（分叉空会话等价于新建，无意义）。
- **执行序**（单 handler 内同步完成）：创建会话行（sdkSessionId=''）→ 批量拷贝消息 → 补列血缘与配置 → 审计事件（`conversation_forked`，payload 记源/新会话 id 与分叉点）。全程不触碰源会话行。
- 命名对齐既有 `duplicate` 先例但取 `fork`：社区术语收敛于此（Open WebUI / LibreChat / Claude Code 均用 fork），且语义是「从某点派生」而非「整体复制」。

## 8. Web UI

### 8.1 入口（两档语义）

- **消息级（核心入口）**：`AssistantThread.tsx` 的 `UserMessage` / `AssistantMessage` 各加一个 hover 操作（分叉 icon）＝**「从此分叉」单档**：复制起始到该条（含该条）的全部消息（D5）。移动端不用 hover：操作簇用 `lg:opacity-0 lg:group-hover:opacity-100` 模式，触屏恒显（绕开侧栏删除按钮 `hidden group-hover:flex` 触屏不可达的既有缺陷）。
- **会话级**：顶栏右簇（复制会话 ID / 反馈 / 文件旁）加分叉按钮 = 「含全部消息创建分叉」（D2）。草稿会话（未落库）不显示任何分叉入口。

### 8.2 交互流

1. 调 `POST /:id/fork`（`webChat.ts` 的 `useWebChat` 加 `forkConversation` callback）。
2. 成功：dispatch 把新会话插入侧栏列表 → `switchConversation(newId)` → toast「已创建分叉，含 N 条消息」。无路由跳转（本站会话切换即内存态，`/` 单页无会话路由，符合现状）。
3. 409（源会话忙）：toast「源会话有进行中的轮次，稍后再试」。

### 8.3 血缘展示

- 顶栏左簇 Badge 序列（引擎 / 知识库 Badge 旁）加**「分叉自 <源标题截断>」**徽标（`ConversationSummary` 加 `forkedFrom` 字段，DTO 从补列派生）。点击徽标 = `switchConversation(源id)`（源会话在列表内且未归档时），归档则降级为纯文本徽标「分叉自已归档会话」。
- 血缘数据模型恒为一级（每会话只存直接父会话列）；**完整上溯链通过逐级回溯实现**（D4）：点徽标切入父会话，父会话徽标再上溯到祖父，逐个回溯即得完整链条——不存链表、不做专用链视图。

## 9. 边界与明确不做

| 项 | 决定 |
|---|---|
| 会话内编辑/重发产生消息树 | **不做**（M3 之后另行立项；线性引擎 transcript 与树切换语义冲突，见 §2） |
| 分叉到其他 agent / 换模型 | **不做**：分叉保持 agentId 与 llmSdkType 原样；换 agent 走「新会话 + % 引用源会话」既有能力 |
| 分叉被分享的会话 | 平台不存在会话分享，无此场景 |
| ⚙️ 工作流轮 / 🔔 通知轮会话 | 可分叉（就是普通会话），无特判 |
| 跨引擎分叉 | 分叉不换引擎；llmSdkType 复制后首个自愈路径 `sdkTypeMismatch` 语义不变 |
| 消息量硬上限 | M1 不设（SQLite 行拷贝成本线性且小）；实测出现滥用再加 500 条/400 软顶 |

## 10. 分期

- **M1（本方案主体，单 feature 分支可完成）**：conversations 补列 ＋ fork handler（复制/守卫/审计）＋ 路由守卫登记 ＋ 统一契约 `forkFrom` ＋ **claude 原生 forkSession（会话级全量）** ＋ zcode/codex 注入降级（claude 中间切点 M1 期暂同注入）＋ worktree 基点覆盖（含 D3 结论的快照策略）＋ Web 入口与血缘徽标 ＋ 测试。验收：claude 会话级分叉→新 session id 经 commit 回写且源 session 不动；降级引擎分叉→首轮审计 prompt 含 `untrusted source="conversation:…分叉继承历史"`；git agent 分叉出的工作树基于源会话分支。
- **M2（claude 中间切点原生化）**：message→transcriptUuid 映射落地（`TranscriptRef.lastMessageUuid` 启用：bot 消息轮末记录、user 消息轮初记录各自对应的 transcript uuid）；中间切点改走 `forkSession(…, { upToMessageId })`，注入退为无原生引擎的常驻兜底。验收：claude 消息级分叉两侧并行对话互不串写、分叉点之后的内容对模型不可见。
- **M3（可选）**：zcode/codex 未来若提供原生 fork 则接入；分叉延迟/次数指标。

## 11. 测试计划

| 层 | 用例 |
|---|---|
| 单元 | 复制语义（新 id/原 createdAt 保序/taskId 置空/血缘落列/sdkSessionId=''）、标题后缀与 auto-title 豁免、inclusive 两档切点、拒绝矩阵（归档 404 / 忙 409 / 空 409 / messageId 不属源 409） |
| web-channel e2e | fork happy path；**IDOR**（他人会话按既有守卫语义拒绝）；守卫登记覆盖（漏登记即 404 的既有 e2e 形态） |
| 注入 e2e（降级引擎；M1 期 claude 中间切点同） | 分叉首轮 prompt 含 wrapUntrusted 历史块（断言 source 标签与保尾截断）；第二轮起不再注入 |
| worktree | git agent 分叉 → 新树分支 `donger-session/<newId>` 基于源分支 HEAD；源分支缺失回退标准基点 |
| M2 专项 | claude forkSession：会话级（M1 即验）与中间切点（upToMessageId 精确截断、被切后文对模型不可见）两侧分叉续跑，transcript 互不污染；`sessionStore` 落 SQLite 验证 |

提交前铁律沿用：`tsc` 全量类型检查（vitest 不做 typecheck）。

## 12. 拍板记录（2026-10-26）

| # | 决策 | 拍板 | 落点 |
|---|---|---|---|
| D1 | 引擎续接路线 | **上层交互与建模统一；引擎层原生优先** | 统一契约 `forkFrom`（§5.2）；claude 原生 forkSession，zcode/codex 无原生能力降级注入（M2 让 claude 中间切点也原生化） |
| D2 | 入口范围 | **支持会话级**（顶栏入口，含全部消息） | §8.1 |
| D3 | 沙箱未提交变更 | **携带（零扰动快照）**——确认框未返回，按建议方案落地；改「不携带/开关」属小改动 | §6：临时索引快照 commit 作基点，源会话零扰动，失败降级 HEAD |
| D4 | 血缘展示 | **每级可查看父会话，逐个回溯构成完整上溯链** | §8.3：数据单列一级＋徽标逐级点击回溯 |
| D5 | 分叉点语义 | **单档「含此条」**：从该条到起始对话的全部内容 | §7/§8.1：`{ messageId }` 恒含此条，去掉 inclusive |

## 13. 实现注意事项（坑清单）

1. **路由守卫登记**：`web-route-guards.ts` 漏登记 = 404（既有铁律，e2e 覆盖）。
2. **maybeAutoTitle 豁免**：分叉会话标题创建时即终态，实现时核对 `orchestrator.ts:1999` 触发条件，防止首轮消息把「<源标题> · 分叉」改名。
3. **taskId 必须置空**：保留会把分叉会话的消息错误关联到源会话的运行/事件。
4. **附件 containment 校验不拦截复制**：`handleSendMessage` 的 attachments 目录校验只作用于**新发送**的附件路径；复制的旧消息 files 仅用于展示回读（`/uploads` 走源目录、同属主通过），两链路勿混。
5. **不共享 sdkSessionId**：任何「先共享后克隆」的优化都是对 §5.1 不变量的破坏，zcode/codex 的 resume 会双写 transcript。
6. **批量插入 updatedAt**：`add` 每次刷新会话 updatedAt，量大时走 `addMany` 旁路（§4.3），勿改 `add` 语义。
7. **heredoc/printf 吞反斜杠**：注入块拼接用 node 侧字符串模板，勿走 shell（既有坑）。
8. **临时索引快照须显式 `GIT_INDEX_FILE`**：不设会把 `add -A` 写进源会话真实索引（污染源工作区）；`commit-tree` 直接产对象、不走工作树。Windows 下临时文件用绝对路径（MSYS 路径坑通用条目）。
