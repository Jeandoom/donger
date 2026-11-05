# 对话模块 UE 深度优化设计

- 日期：2026-11-05
- 状态：已拍板（2026-11-05：D1-D6 全按推荐落定）；M1+M2 实施轮（feat-20261105-chat-ue worktree），M3 各项待专项
- 需求来源：对话模块 UE 深度优化（2026-11-05 对话）
- 调研基线：前端全量读码（master 1c0de3dd 谱系）+ 后端数据面读码 + 社区方案调研（OpenAI Codex、Claude Code web、ZCode CLI、Open WebUI / LobeChat / LibreChat、Chat UI 完整规格）

## 0. 一句话与设计哲学

社区共识一句话：**AI 对话页不是消息应用，是「执行过程的实时窗口」**——它展示一个会读文件、思考、调工具、流式作答的进程。本设计不按消息气泡逐条修补，而是先把对话 UE 收敛为**六个能力域**（会话组织 / 回合呈现 / 决策干预 / 输入 / 可靠性性能 / 视觉可达），每域给目标态，场景只当验收样板。

三条架构优先的锚定判断（决定全案走向）：

1. **「过程透明」的数据后端已全部具备，前端却大面积零渲染**——`activity` 事件（工具摘要行）已推但无组件消费、`stage` 死状态、per-turn token/model/duration 躺在 audit result 行里没人展示、助手名硬编码 `"donger"`。M1 纯前端即可点亮一块完整能力，不动后端。
2. **「消息编辑/重发」不新造平行机制**——平台已有会话分叉一等能力（整史 + 消息级切点 + 血缘链）。社区模式「edit 即 branch」与现有 fork 能力同构：消息级编辑 = fork 的 UI 化，而非新的引擎重跑机制。多引擎 resume 架构下真 regenerate（原地重跑）成本高（需弃 resume 指针重开会话），列为 M3 待评估，不上 M1/M2。
3. **唯一必须动后端的域是「会话组织」**——列表无分页/无摘要/无未读/无重命名/无归档出口/无搜索，这是社区产品（ChatGPT、Claude、LobeChat、Open WebUI）全都有的基本盘，且现有数据面撑不起任何现代列表 UX。

## 1. 现状锚点（读码结论）

### 1.1 前端能力面（web/src）

| 部件 | 位置 | 现状 |
|---|---|---|
| 页面骨架 | `pages/ChatPage.tsx` + `components/chat/ChatWorkspace.tsx` | 三栏：左 agent 分组会话侧栏（lg）/ 中间消息流 / 右文件抽屉；顶栏 SDK 徽标 + 分叉血缘 + 反馈 + 文件抽屉 |
| 消息流 | `AssistantThread.tsx`（599 行） | assistant-ui primitives + MarkdownTextPrimitive；回合合并（taskId）、工具折叠卡、思考折叠块、行号徽标、审批/凭证/问询卡锚点 |
| 会话侧栏 | `AgentConversationSidebar.tsx`（431 行） | 按 agent 分组、星标 + dnd 拖拽、每组截 5 条、标题搜索（≥8 条才显示）、折叠记忆 |
| Composer | `AssistantThread.tsx` + `ComposerMentions.tsx`（524 行） | 五类引用（@文件/技能/$连接器/%会话/#反馈）背衬 pill、附件 ≤5×20MB、权限模式/模型原生 `<select>` |
| 状态机 | `chatReducer.ts`（502 行）+ `webChat.ts`（864 行） | 16 种 SSE 事件 → reducer 回合聚合；乐观发送 delivery=sending/accepted/failed（**无组件渲染 delivery**）；切会话五路并行拉取 |
| 决策卡 | `PendingInteraction.tsx` + `QuestionCard.tsx` | 审批卡（随流滚动消失）、凭证卡、问询卡（sticky 输入区上方常驻）——同类卡行为不一致 |
| 文件面 | `FileBrowserDrawer.tsx` + `FileChangesTab.tsx` | 双 tab 文件树 + 变更 diff；消息内变更链接直达 |

### 1.2 后端数据面（src/）

| 面 | 现状 |
|---|---|
| SSE | 16 事件全量（text/thinking 增量、tool_use/result、activity、三卡、result、eviction、draining、resync），Last-Event-ID 断线重放（环形缓冲 500 条/15min） |
| 消息/历史 | messages 表仅 user/bot 两 role；GET /messages、GET /events **均全量无分页** |
| 会话列表 | GET /api/conversations 全量、无搜索参数、无未读、无最后消息摘要、无重命名端点（PATCH 仅收 permissionMode）、删除=软删无恢复出口 |
| 运行态 | 无 run 状态 SSE 事件，前端靠 `result` 推断；activity 内存态靠 GET /activity 轮询；busy 队列（≤5 条/会话）纯内存无暴露 |
| 用量 | audit `result` 行带 per-turn 四项 token + model + durationMs；/api/usage 按 taskId 可查；**无金额** |
| 搜索/导出/分享 | 全部缺失（audit LIKE 仅 agent 内部工具可用） |

## 2. 痛点清单（归域后；证据 file:line）

### E1 会话组织域
- E1-1 列表按 agent 分组硬截 5 条 + "Show more（N）" 中英混排，无时间分组（`AgentConversationSidebar.tsx:41,196`）
- E1-2 搜索仅标题子串且 ≥8 条才显示入口，无内容搜索、无快捷键（`:249,343`）
- E1-3 删除确认「无法恢复」与后端软删语义矛盾，且归档会话无任何 UI 出口（`:421` vs `webChat.ts:748`）
- E1-4 无重命名（后端无端点）、标题仅「首条消息截 30 字」规则生成
- E1-5 会话列表/消息历史全量无分页，长会话首屏重（`ChatPage.tsx:162`）
- E1-6 无未读信号（通知系统有 unread-count 但列表徽标不联动）

### E2 回合呈现域
- E2-1 `activity` 事件（🔧 工具摘要行）已推送、`stage` 已入 reducer，**两者零组件消费**——执行过程用户不可见（`chatReducer.ts:329`，grep 零命中）
- E2-2 无 per-turn 徽标：token/耗时/模型数据在 audit result 行已备，前端不显示
- E2-3 助手名硬编码 `"donger"`，不随 agent 变化（`AssistantThread.tsx:359`）
- E2-4 工具卡 running 判定=`result===undefined`，输入摘要仅四键，无结构化参数/图片结果渲染（`ToolCard.tsx:55,75`）
- E2-5 流式指示仅「思考中三点」且只在回合无内容时显示；无打字光标、无停止后「已保留部分回答」注记
- E2-6 历史时间戳「今天/更早」即时计算不随跨天刷新（`:208`）

### E3 决策与干预域
- E3-1 三类决策卡行为分裂：审批/凭证卡随流滚动消失（历史里不可达），问询卡 sticky 常驻（`AssistantThread.tsx:503-523`）
- E3-2 busy 排队消息用户无感知（无「排队中」状态、无队列深度）
- E3-3 审批卡/凭证卡硬编码亮色（`bg-white/60`、`text-blue-800`），脱离令牌体系（`PendingInteraction.tsx:58,112`）

### E4 输入域
- E4-1 权限模式/模型选择器是原生 `<select>`，与自绘体系割裂，窄屏挤压截断无提示（`ChatWorkspace.tsx:174-215`）
- E4-2 无消息级 copy/引用回填；发送失败无红标无重试（delivery 状态全链路备好零渲染）
- E4-3 触发符插入靠原生 setter + 手工 dispatchEvent hack，两处重复（`AssistantThread.tsx:473`、`ComposerMentions.tsx:279`）
- E4-4 附件超限仅发送前 toast，不提前 disable（`chatMessageAdapter.ts:115`）
- E4-5 无快捷键体系（无 Esc 停止、`/` 聚焦、Cmd+K）；IME/Enter 策略未显式处理
- E4-6 移动端 sticky 堆叠（问询卡+提示+错误+输入）可吃满屏，无 safe-area inset

### E5 可靠性与性能域
- E5-1 无虚拟化/无 `content-visibility`，每字符 delta 全量拷贝 parts（`chatReducer.ts:108`）
- E5-2 无「回到底部」按钮（assistant-ui scrollToBottom primitive 未用）；上翻被打断
- E5-3 切会话必清空重拉、来回切换闪 loading
- E5-4 重连只有一句文案，无倒计时/手动重连；错误三色条纵向堆叠
- E5-5 16 段 addEventListener 样板、connectSSE 依赖数组缺失（`webChat.ts:180,384`）

### E6 视觉与可达域
- E6-1 无暗色模式（令牌已预留注释「阶段 0 不实装」），代码块/决策卡多处硬编码亮色，与 PWA 深色 theme_color 割裂
- E6-2 触屏可达性靠 lg 以下恒显补丁，侧栏删除/星标仍是 group-hover 触屏不可达（`AssistantThread.tsx:64`、`AgentConversationSidebar.tsx:134,180`）
- E6-3 分叉血缘逐级跳转无链路视图；无全局 toast 系统（横幅自清）
- E6-4 i18n 缺位（中文硬编码 + Show more 等混排）

## 3. 社区调研结论（可借鉴模式清单）

| 来源 | 借鉴点 |
|---|---|
| **Chat UI 完整规格**（ayeeye.net 设计哲学长文） | 「live window onto a process」总纲；消息=typed parts（text/reasoning/tool + status）；五态流式指示（sending/waiting/streaming/done/stopped/error 各有形）；发送即时乐观显示、思考指示 300ms 内出现、10s 后加「Still working」；工具卡默认折叠+状态用文字**和**颜色双编码；审批卡必须 stop run、幸存刷新、到过期而非自动通过；「Jump to latest」浮标（>48px 离底时出现）；**侧栏按 Today/Yesterday/Last 7d/30d/Older 分组**、20 条分页骨架屏、每条菜单 Rename/Pin/Share/Delete(确认+Undo toast)；消息操作=答下 Copy/Regenerate/👍👎、用户消息 Edit/Copy、**Edit 即 branch + ‹2/3› 版本切换**；thread 用 `role="log"`、流式文本不进 aria-live（完成后单次播报）；rAF 批量 flush 增量、`content-visibility: auto` 按回合豁免最新回合；composer ≥16px 字号防 iOS 缩放、IME `isComposing` 守卫、触屏 Enter=换行 |
| **OpenAI Codex**（桌面/Web） | 任务式 agentic 工作流卡片化；紧凑执行时间线（terse 模式）vs 对话叙事（conversational 模式）双风格并存 |
| **ZCode CLI**（本平台三引擎之一，自家参照系） | 工具卡（名+折叠入参+状态色）、AskUserQuestion 选项卡、计划模式确认卡、todo list 过程外化、Esc 中断、忙碌时可排队输入并显示排队 |
| **Open WebUI / LobeChat / LibreChat** | 会话搜索/置顶/归档/文件夹/标签是标配；fork/clone 会话是标配（donger fork 已有，缺 UI 密度）；消息 regenerate/edit 是标配；LobeChat 主题面（暗色一等） |
| **claude-code-webui** 等开源参照 | 移动端优先布局、会话列表时间分组、工具调用移动端折叠策略 |

## 4. 目标架构：六能力域

### 4.1 E1 会话组织域

**目标态**：会话是一等资产，agent 是属性不是容器。侧栏 = 单一时间流列表（今日/昨日/7 天/更早分组）+ 顶部搜索框常驻 + agent 维度筛选（下拉或图标行）+ 「全部/星标/归档」三视图切换。

| 改造项 | 前端 | 后端 |
|---|---|---|
| E1-A 列表重构为时间分组扁平流，条目带 agent 徽标 + 最后消息摘要（1 行截断）+ 未读点 | 重写 `AgentConversationSidebar` 为 `ConversationSidebar`（agent 分组模式保留为可选视图，见 D1） | **列表 API 升级**：游标分页（limit+before）+ 返回 `lastMessagePreview`（store 联表取末条 user/bot 文本截 80 字）+ `unreadCount`（复用通知 unread-count 按 conversationId 聚合或 conversations 表加 lastSeenAt 列） |
| E1-B 重命名：条目菜单「重命名」→ PATCH 扩收 `title` | 行内编辑 | PATCH /:id 扩 title 字段（校验长度，落审计 seq=-1） |
| E1-C 归档闭环：删除文案改「移入归档」+ Undo toast（前端延迟执行）+ 归档视图（列表切换 archived=1）+「恢复」 | 前端三态切换 | DELETE 语义不变；列表支持 `?archived=1`；恢复=PATCH archived:false |
| E1-D 星标保留（现有 pin 语义），拖拽排序在扁平流下退役（时间序即序），星标区置顶 | 简化 agentSidebar.ts | 无 |
| E1-E 搜索：M1 仅标题（现有）改为常驻入口 + Cmd+K 唤起全页面板（会话+消息跳转，见 E1-F） | 前端 | 无 |
| E1-F 消息全文搜索（M3）：FTS5 影子表（汉字逐字切分，KB 轮已实证分词坑）+ REST + Cmd+K 面板接入 | 面板复用 | FTS 建表+增量触发器+搜索端点 |

**后端量**：列表 API 升级 + PATCH 扩 title + archived 过滤 ≈ 小型改动；FTS 为 M3 独立块。

### 4.2 E2 回合呈现域

**目标态**：每个回合是「带执行时间线的叙事块」——Codex 式紧凑时间线承载过程，叙事正文承载结论；回合头有元信息徽标。数据全部已在手，纯前端改造。

| 改造项 | 说明 |
|---|---|
| E2-A **执行活动条**：回合运行中，正文上方渲染 activity 摘要行（`🔧 tool …`）滚动区，完成时收拢为「N 次工具调用」折叠徽章（点击展开完整 ToolCard 时间线）。消费现有 `activity` SSE + `stage` 状态，M1 即可点亮 |
| E2-B **回合头徽标行**：时间戳（+定时刷新）· 模型名（audit result 行 model / 会话 llmSdkType）· token（input+output，result 行四项 token 求和）· 耗时（durationMs）· 失败/停止注记。数据源 `GET /events` 回放已有 |
| E2-C 助手名/头像 agent 化：顶栏当前 agent 名 + 首字母徽标替换硬编码 `"donger"` |
| E2-D 流式五态显式化：sending（user 气泡半透明）/waiting（骨架 shimmer）/<300ms 进入 streaming（打字光标）/stopped（保留部分回答+「已停止」注记）/error（一句话+重试）。思考指示超 10s 追加「仍在工作」 |
| E2-E 工具卡强化：状态文字+颜色双编码；输入摘要按键结构化（Bash=命令、Edit=文件+增删行数）；图片结果直出（tool_result 预览已是文本，图片走 files 链接渲染） |
| E2-F 停止按钮状态化：waiting/streaming 时发送钮变停止钮（Esc 亦可），复用现有 cancel 端点 |

### 4.3 E3 决策与干预域

**目标态**：三类「需用户决策」的卡（审批/凭证/问询）统一为 **sticky 决策区**：锚定输入区上方常驻（问询卡现状），带摘要行可折叠；历史中的决议卡降级为内联记录（不可再操作）。这是 agent 产品的信任面，社区规格明确要求「pending approvals survive reload」——donger 三卡恢复链路已具备，差的只是呈现统一。

| 改造项 | 说明 |
|---|---|
| E3-A 决策区统一容器：`DecisionDock` 单组件承载三卡（现状三处各自锚点），多卡并存时纵向堆叠+计数徽标；关闭=决议后内联留痕 |
| E3-B 审批卡文案强化：破坏性操作按钮重复事实（「删除 14 个文件」而非「确认」），「通过并记住」区令牌化 |
| E3-C 排队可视化：busy 时发送的消息气泡显示「排队中 · 第 N 位」；后端需小改——SSE 增发 `queue_depth`（入队/出队时机，orchestrator 已有队列数组）或在 activity 事件里附带 |
| E3-D 淘汰/排水事件卡化：eviction_notice / server_draining 从错误横幅改为对话内系统卡片（可折叠、带原因与指引） |

### 4.4 E4 输入域

**目标态**：Composer 是产品级输入面——自绘选择器、显式键盘契约、失败可恢复。

| 改造项 | 说明 |
|---|---|
| E4-A 权限模式/模型选择器自绘化：替换两处原生 `<select>` 为 ui/ 下 Popover 风格选择器（展示完整模型名、当前项勾标）；移动端走底部 sheet |
| E4-B 消息操作面：助手回合 hover/长按操作条 = Copy（含「复制全文」+1.5s 已复制反馈）/ 引用回填（把该条内容引回 composer）/ 从此分叉（现有）；用户消息 = Edit（见 D2）/ Copy |
| E4-C 键盘契约：Esc=关浮层→停止生成（分层）；`/` 聚焦输入；Cmd/Ctrl+K 命令面板；`?` 快捷键帮助 sheet；IME `isComposing` 守卫 + 细指针 Enter 发送/触屏 Enter 换行（现状需核实一致后再定，见 §7） |
| E4-D 附件体验：超限即时 disable + 计数提示（5/5），上传中 chips 带进度，未完成时发送禁用 |
| E4-E 草稿持久化：per-conversation 草稿存 localStorage，切会话不丢；发送失败恢复文本（现状失败即丢） |
| E4-F 移动端 composer：`16px` 字号、safe-area-inset-bottom、sticky 堆叠高度预算（问询卡折叠为摘要行 + 展开态） |

### 4.5 E5 可靠性与性能域

**目标态**：流是韧性的，列表是轻的。

| 改造项 | 说明 |
|---|---|
| E5-A delivery 状态落地渲染：sending 半透明→accepted 实色→failed 红标+「重试」按钮（reducer/adapter 数据已备，纯渲染接线） |
| E5-B 回到底部浮标：离底 >48px 出现「Jump to latest」+ 未读增量计数；新回合到达且用户在底部才跟随滚动，上翻永不打断 |
| E5-C 流式渲染性能：delta 按 rAF 批量 flush（后台 tab 250ms 定时器）；回合级 memo（`content-visibility: auto` 豁免最新回合）；虚拟化不做（见 D5） |
| E5-D 切会话缓存：最近 3 个会话消息 reducer 常驻缓存（Map），切换零闪；后台静默刷新 |
| E5-E 重连体验：重连横幅带尝试计数与「手动重连」按钮；重连成功 toast 一条（现状静默全量重建） |
| E5-F 代码债清偿：16 段 addEventListener 收敛为事件表驱动（`sseHandlers: Record<type, handler>`）；修 connectSSE 依赖数组 |

### 4.6 E6 视觉与可达域

**目标态**：一套令牌走天下，触屏与键盘同权。

| 改造项 | 说明 |
|---|---|
| E6-A 令牌清偿：硬编码亮色（审批卡 `bg-white/60`、代码块 `#282c34`、凭证卡 blue 系）全部换语义令牌；**暗色模式本身不做**（见 D4，独立轮） |
| E6-B 触屏可达统一规范：操作按钮一律「hover 显现（细指针）/ 常驻（触屏）」，媒体查询 `@media (pointer: coarse)` 一处定义全局复用，替换现有 lg 断点 hack |
| E6-C a11y 基线：thread `role="log"`、消息 `<article>` 标注、流式文本不进 aria-live、2px 焦点环、200% 缩放布局不破 |
| E6-D 分叉血缘面包屑：顶栏血缘徽标点击弹链路视图（A→B→C 可逐跳），替代逐级跳转 |
| E6-E 全局 toast 系统：现散落横幅收敛为 ui/toast（成功/失败/撤销三型，Undo 用于 E1-C 归档） |

## 5. 分期落地

### M1 —— 纯前端点亮（零后端改动，快速见效）
E2-A 活动条 · E2-B 徽标行 · E2-C 助手名 agent 化 · E2-D 流式五态 · E2-F 停止状态化 · E3-A 决策 Dock · E3-D 事件卡化（eviction/draining）· E5-A delivery 渲染 · E5-B 回到底部浮标 · E6-A 令牌清偿 · E6-B 触屏规范 · E2-F 同含 E4 部分键盘（Esc 分层）

### M2 —— 会话组织 + 输入升级（前后端小改）
E1-A 列表重构（分页/摘要/未读）· E1-B 重命名 · E1-C 归档闭环 · E1-D 扁平化+星标 · E1-E Cmd+K 面板（标题级）· E3-C 排队可视化（SSE 小改）· E4-A 自绘选择器 · E4-B 消息操作面 · E4-C 键盘契约全量 · E4-D/E4-F 附件与移动端 composer · E5-C 性能批处理+memo · E5-D 会话缓存 · E5-E 重连体验 · E5-F 事件表驱动 · E6-D 血缘面包屑 · E6-E toast 系统

### M3 —— 重投入项（独立评估）
E1-F 全文搜索（FTS5 汉字切分影子表）· E2 真 regenerate（引擎层语义：弃 resume 重开 or 引擎原生 retry，需专项设计）· 暗色模式全量轮 · i18n 轮 · 会话导出（Markdown/JSON）· D5 虚拟化复议

### 痛点→分期覆盖核对

| 域 | M1 | M2 | M3 |
|---|---|---|---|
| E1 | — | A/B/C/D/E | F |
| E2 | A/B/C/D/F | E | regenerate |
| E3 | A/D | B/C | — |
| E4 | （Esc） | A/B/C/D/E/F | — |
| E5 | A/B | C/D/E/F | 虚拟化复议 |
| E6 | A/B | C/D/E | 暗色/i18n |

## 6. 拍板点

- **D1 会话侧栏组织模型**：扁平时间流 + agent 筛选（推荐——会话一等资产，agent 是属性；社区全线如此；agent 分组视图保留为切换项，默认扁平） vs 保留 agent 分组强化（组内时间排序+组折叠计数）。
- **D2 消息级「编辑」语义**（E4-B）：①推荐 = **编辑→从该条分叉新会话**（fork UI 化，血缘链已有，语义诚实）+ 编辑文本自动回填 composer 预填；②轻量 = 仅「引用回填」不做编辑态；③重量 = 真 regenerate 原地重跑（需弃 resume 指针/多引擎差异大，挂 M3）。
- **D3 回合徽标信息密度**（E2-B）：①推荐 = 时间+模型+token+耗时四徽标（数据全备）；②仅时间+模型（克制）；③加成本金额（**后端无金额数据**，usage token-only，需定价表配置面，不建议）。
- **D4 暗色模式**：①推荐 = 本轮只做令牌清偿（E6-A），暗色主题独立轮（涉及全平台页面+PWA theme_color，面大）；②纳入 M3 一并做。
- **D5 长列表虚拟化**：①推荐 = content-visibility + rAF 批量 + 回合 memo（轻方案，无虚拟化维护成本）；②上真虚拟化（assistant-ui 虚拟化支持有限，需评估替换面，收益存疑）。
- **D6 排队可视化后端改动**（E3-C）：①推荐 = SSE 增发 queue_depth 事件（小改）；②不做，排队仅靠现有文本提示（orchestrator 队列提示已存在）。

## 7. 风险与坑

1. **assistant-ui primitive 边界**：`useExternalStoreRuntime` 桥接已固化（adapter/reducer 双层），E2-D 五态/E5-B 浮标优先用其 primitives（scrollToBottom、isRunning），不可用再绕库自绘；触发符插入 hack（E4-3）在改动 composer 时须保留现有 e2e 兼容（2026-09-17 实锤补丁，勿顺手清理）。
2. **IME/Enter 现状核实**：社区规格要求 IME 守卫，donger composer 现行为未读断——M2 动键盘契约前先真机核（中文输入法 Enter 误发送是否已防）。
3. **列表重构波及面**：`agentSidebar.ts` 纯逻辑+测试、偏好双写（users 表+localStorage）、`?conv=` 深链定位均耦合在现侧栏，重构须保深链回归（工作流执行记录「查看对话」全靠它）。
4. **并行会话铁律**：chat 模块是多轮并行冲突高发区（历史上 web-channel/AssistantThread 被并行收编两次），动码轮须 worktree 隔离 + 提交前 `git show :file` 验 blob。
5. **PWA 旧 bundle**：发布后用户滞留旧 bundle 是二次坑（prompt 模式），UE 改版上线时观察 stream-reconnected 自动换血是否足量覆盖，必要时在 M2 评估 autoUpdate。
6. **tsc 基线**：web tsc 零错是当前红线（后端 360 触达基线零错），动 chatReducer/webChat 大文件的轮次收尾必跑全量。
7. **SSE token 走 query**（`webChat.ts:171`）属已知泄露面，本设计不改（动鉴权面超出 UE 范围），记录待专项。

## 8. 验收样板（场景只当样板）

1. **长会话回看**：打开 200+ 回合会话——首屏 <2s（分页+缓存）、上翻不被流打断、浮标一键回底、回合头能看到每轮模型与 token。
2. **执行等待**：发送一条触多工具的任务——<300ms 出现状态指示、活动条滚动显示工具摘要、完成收拢为徽章、上翻回看时审批卡仍钉在输入区上方可达。
3. **决策闭环**：审批卡手机端可达（触屏常显按钮）、破坏性按钮文案重复事实、决议后内联留痕、刷新后卡片恢复。
4. **发送失败**：断网发送——气泡红标「未送达·重试」、文本不丢、重连后自动重试或手动一键。
5. **会话整理**：重命名一条会话、归档一条（Undo toast 可撤销）、Cmd+K 搜标题跳转、归档视图里恢复一条。
6. **消息编辑**：对一条旧用户消息点「编辑」——确认弹窗说明「将从此处创建分叉会话」→ 新会话含此前历史 + 编辑后文本，顶栏血缘面包屑可回原会话。
