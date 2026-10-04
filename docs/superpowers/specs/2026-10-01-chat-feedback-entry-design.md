# 对话内反馈入口 + 会话 ID 复制 设计稿

日期：2026-10-01
状态：待拍板（本稿只评估与设计，未动代码）
关联：docs/superpowers/specs/2026-09-20-feedback-module-design.md、docs/superpowers/specs/2026-09-28-feedback-conversation-attachment-design.md

## 1. 需求

用户在对话模块中开始对话后：

1. 能复制当前会话 ID，方便在反馈或其他渠道定位问题；
2. 能直接在对话中发起反馈，且反馈自动带上当前会话的引用，免去去反馈页手动挑选会话。

## 2. 现状盘点（能力已存在，缺的只是对话侧入口）

| 能力 | 现状 | 锚点 |
| --- | --- | --- |
| 反馈创建 API 支持关联会话 | ✅ 已上线。`POST /api/feedback` 收 `conversationIds`（≤1 条），`sanitizeFeedbackConversations` fail-closed 校验「本人会话」，防 IDOR；只存指针不落快照 | `src/adapters/web-channel.ts:3722`、`:6295` |
| 前端反馈提交带会话引用 | ✅ `createFeedback({ conversationIds })` 契约就绪 | `web/src/lib/feedback.ts:83` |
| 反馈页会话选择器 | ✅ 反馈页表单有 `ConversationPickerDialog`（本人会话分页+搜索） | `web/src/pages/FeedbackPage.tsx:315`（FeedbackForm）、`:506`（Picker） |
| agent 侧读取关联转录 | ✅ `# 反馈` 引用注入时现读会话转录（wrapUntrusted） | `web-channel.ts` resolveFeedbackMentions |
| 对话头部动作区 | 仅有「文件」一个按钮，会话 id/反馈入口均无 | `web/src/components/chat/ChatWorkspace.tsx:220-228` |
| 剪贴板复制模式 | 站内已有 8 处 `navigator.clipboard?.writeText` 先例（授权页/MCP/邀请等） | `AuthorizationPage.tsx:130` 等 |

关键结论：**两项需求后端零改动**。反馈服务常驻装配（`src/index.ts:135`），无平台级开关需要隐藏入口；会话属主校验在服务端 fail-closed，对话内入口传的是用户自己的 `activeConversationId`，校验天然通过。

## 3. 可行性评估

### 3.1 复制会话 ID —— 可行，纯前端约 20 行

- `ChatWorkspace` 头部已有 `props.activeConversationId`，直接 `navigator.clipboard?.writeText`；
- 生产为 HTTPS（3330），clipboard API 可用；dev localhost 同为安全上下文；写法跟随站内可选链兜底模式；
- 无后端、无守卫、无安全面变化（会话 ID 是 uuid，泄漏无直接风险，服务端所有会话读取均有属主校验）。

### 3.2 对话内发起反馈（自动带会话引用）—— 可行，前端组件抽取

- 复用既有 `FeedbackForm`（类别/内容/截图/关联会话全齐），唯一缺口是「预填关联会话」：加一个可选 prop `initialConversation` 即可；
- 形态采用弹窗（`DialogShell` 已是全站统一表单弹窗外壳）而非跳转反馈页：不打断对话上下文，提交后回到原对话；
- 边界：草稿会话（未发首条消息，无 id）时入口禁用并给 title 提示；会话在弹窗打开期间被删则提交时命中后端 400，错误文案照常展示在表单错误区（fail-closed 已兜底）。

### 3.3 风险与协调

- **并行冲突**：worktree `D:/code/donger-wt-feedback`（分支 fix-20261001-feedback-mobile）当前对 `web/src/pages/FeedbackPage.tsx` 有未提交修改。本设计要抽取该文件的组件，**实施须待该会话合入后进行**，或与其协调合并顺序；
- 反馈限流（10 条/时）、截图上传（≤3 张/2MB）、`feedback.created` 事件触发器等全部继承不变。

## 4. 方案设计

### A. 会话 ID 复制（ChatWorkspace 头部）

- 位置：头部动作区「文件」按钮左侧，新增 icon button（lucide `Copy`），`aria-label`/`title`=「复制会话 ID」；
- 行为：点击复制 `activeConversationId`，按钮文案短暂变为「已复制」（1.5s 本地 state，同 McpSection 模式）；
- 可见性：仅 `activeConversationId` 存在时渲染（草稿态无 id 不显示）。

### B. 对话内反馈入口（ChatWorkspace 头部 + 弹窗）

- 位置：同头部动作区，新增「反馈」按钮（icon+文字，同「文件」样式族）；
- 可见性：`activeConversationId` 存在且非草稿时可用；草稿态禁用，`title`=「发送首条消息后可对此会话提交反馈」；
- 点击打开 `DialogShell`（title=「提交反馈」，subtitle=「将自动关联当前会话作为证据」）；
- 弹窗内为共享 `FeedbackForm`，`initialConversation={当前会话}`，表单内以既有「已选中会话 chip」形态呈现，可移除/更换（复用 Picker）；
- 提交成功：弹窗关闭 + 内联成功提示（沿附件错误条样式），不跳页。

### C. 组件抽取（复用既有抽象）

- `web/src/pages/FeedbackPage.tsx` 内的 `FeedbackForm`、`ConversationPickerDialog` 迁至 `web/src/components/feedback/`，FeedbackPage 改 import；
- `FeedbackForm` 新增可选 prop：`initialConversation?: ConversationCandidate`（useState 初始化器消费）与 `onCreated` 保持不变；
- 页面级纯移动 + 单 prop，回归面小。

### 备选方案（否决记录）

- 深链 `/feedback?conversation=<id>` 预填：零抽取成本，但跳页打断对话上下文、返回需自行找回，体验差；
- 弹窗内手写轻量表单：违反「单表单单真源」，截图上传/草稿收编逻辑重复。

## 5. 待拍板点

1. 反馈入口形态：推荐**弹窗**（备选深链跳页）；
2. 复制 ID 呈现：推荐**头部 icon button + 已复制瞬态**（备选：折叠进「…」溢出菜单——当前头部动作仅 1 个按钮，开菜单不划算）；
3. 草稿会话处理：推荐**禁用+提示**（备选：点击时先 `onEnsureConversation` 落库再弹窗——为关联反馈隐式创建会话，语义存疑）。

## 6. 实施与测试

- 顺序：等 fix-20261001-feedback-mobile 合入 → C 抽取 → A/B 落点 → 回归；
- 测试：web vitest（FeedbackForm `initialConversation` 预填 + 提交 payload 含 conversationIds；头部门禁用态）；后端无改动不新增用例；真机冒烟=复制 ID + 弹窗提交反馈后在反馈页/详情页核对关联会话；
- 工作量：纯前端约 0.5 人日。
