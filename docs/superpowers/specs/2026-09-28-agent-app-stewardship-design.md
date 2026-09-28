# 应用管家制：智能体×应用责任闭环设计（spec，待拍板）

- 日期：2026-09-28
- 状态：**已拍板实施（2026-09-28 五拍板点全部同意；P0=8811ba9，P1+M2=同日随版）**
- 关联：应用内核 M1（`src/domain/app.ts` / `src/orchestrator/app-tools.ts` / 应用管家 `app-manager-agent.ts`）、事件触发器（spec 2026-09-28-event-trigger-feedback-design，已实施 b87cfdb）、通知模块（spec 2026-09-28-notification-module-design）、反馈对话化（c848a39）、zcode 引擎提示链缺陷（排障 2026-09-28，见 §4 前置地基）

## 1. 需求与背景

排障事故（2026-09-28 13:44）：自建智能体 `maycur-ai-coplit-app` 被问「你是干什么的」，答「我是 ZCode 编程助手」。复盘结论：这不是一句提示词缺失，而是**「智能体对应用的责任」在平台上没有载体**——agent 的 name/description 宣告了职责（「maycur AI平台运维助手app管理」），但平台没有任何机制让（a）模型知道、（b）事件找到它、（c）数据围着它转。

现状缺口清单：

| # | 缺口 | 现状证据 |
|---|---|---|
| 1 | 应用无管家字段 | `PlatformApp` 无 agent 绑定；「谁负责这个 app」只存在于用户脑子和 agent 描述自由文本里 |
| 2 | 身份不进执行轮 | `runtime-manager.ts:204` 只透传 `agent.systemPrompt`；name/description 只进 dispatcher 路由表（`dispatch-flow.ts:48-64`） |
| 3 | 事件无责任路由 | `app.published` 等事实发生后，没有「通知/触发责任 agent」的语义（触发器管线已在，缺事件与订阅对象） |
| 4 | 反馈与应用无关联 | `Feedback` 无 appId；反馈是平台级的，不能定向到某应用的管家 |
| 5 | zcode 引擎丢整条提示链 | `zcode-agent-runner.ts` 不消费 `systemPromptAppend`——人设/默认约定/untrusted 前言/记忆/KB 全不达模型（排障轮实证） |

## 2. 架构定位（先抽象，场景只当验收样板）

核心抽象：**责任绑定（Stewardship）**——「应用 ↔ 责任智能体」升级为平台一等关系。身份声明、上下文注入、工具上下文、事件路由、反馈分派五件事全部**派生**自这条绑定，一个真源，不做五套配置。

闭环全景（粗体为本次新增）：

```
开发（agent 对话内 app_create/app_deploy，绑定自动落）
  → 发布（app.published 事件）→ 通知（owner：发布完成+回滚入口）
  → 反馈（应用页「反馈」入口，M2 带 appId）
  → 路由（feedback.created × appId → 管家接单会话/通知）
  → 迭代（管家 agent 修复 → 重新 app_deploy）
  → 闭环（反馈 resolved + 新版本 + 通知提交人）；异常回滚（app.rolled_back 事件告警）
```

复用度：事件投递管线（dispatch→matcher→持久化队列→泵）、通知目录（fail-closed 枚举+组粒度偏好）、反馈状态机与对话化、agent 配置 scope 惯例、wrapUntrusted 信任规则——全部复用。本设计**零新机制**，只有三处受控扩展：事件名注册表、通知事件目录、apps 表一列。

## 3. 数据模型：责任绑定

### 3.1 真源放 app 侧（拍板点①）

```sql
ALTER TABLE apps ADD COLUMN managerAgentId TEXT;   -- 弱引用；NULL=内置应用管家兜底
```

- `PlatformApp.managerAgentId?: string`。选 app 侧作真源的理由：
  - 事件路由与反馈分派都以 app 为起点，O(1) 反查，无需扫描 agents；
  - `app_create` 时执行 agent 在手（见 §5），绑定可在创建瞬间自动落，闭环自然成立；
  - agent 删除/失效时 app 侧置空即自愈（弱引用惯例，同 `knowledgeBaseIds` 读时降级）；
  - 单一真源，避免 agent.appIds 与 app.agentId 双写漂移。
- agent 配置页的「管理的应用」是**反查视图+代理编辑**（保存时写 apps 表）：满足「通过智能体配置等方式」的交互诉求，不制造第二个真源。
- 校验：`managerAgentId` 指向的 agent 须 `ownerId === app.userId`，或为内置应用管家 id（全局兜底豁免）；指向不存在/越权 agent 时读时降级 NULL。
- **内置应用管家 = 全局兜底管家**：无管家应用的事件与反馈路由到它（与它现有 prompt 的全生命周期定位一致）。
- 多管家（开发/运维分职）不做，`managerAgentId` 单数保证路由确定性；将来需要时演进为带 role 的数组，schema 不堵路。

### 3.2 责任历史免费获得

`app_versions.createdBy` 已记录每次发布者，配合 `managerAgentId` 即可回答「这应用谁在管、历史上谁发布的」，不重复建设。绑定变更记 `system_events`（`app.steward_changed`，含前后值与操作者）。

## 4. 身份与上下文派生（运行时）

### 4.0 前置地基（P0，独立先行合入，不等本设计拍板）

zcode runner 补 `systemPromptAppend` 消费：把提示链写进 agent workspace 的 `AGENTS.md`（codex 同款先例 `codex-agent-runner.ts:149`；CLI bundle 实证 ZCode 原生读取 AGENTS.md，`NodeContextSourceAdapter` 文件表即 `["AGENTS.md"]`、100KB 上限）。实施前 headless spawn spike 一次验证。**没有它，本节所有注入在 zcode 会话全部落空**——这是身份问题的直接根因，也是本设计所有注入面的载体。

### 4.1 身份与责任节（runtime-manager agent 分支，用户 systemPrompt 之前）

```
## 身份与自我介绍
- 你是运行在 donger 平台上的自动化智能体。用户问「你是谁/你是干什么的」时，
  按下方「智能体身份」「责任应用」作答；底层 CLI 与模型（如 ZCode、GLM）是实现细节，
  仅当用户明确追问技术栈时如实简短说明，不得作为自我介绍的主身份。

## 智能体身份
- 名称：{agent.name}（wrapUntrusted 包裹）
- 职责：{agent.description ?? "见下方工作说明"}（wrapUntrusted 包裹）

## 责任应用          ← 派生自绑定，本设计新增
- 「{app.name}」：{app.description}｜运行路径 /apps/{appId}/｜当前 {vN|未发布}｜runtime: static
（内置应用管家：注入其名下全部应用清单——兜底管理范围）
```

- 全部经 `combineSystemPromptAppend` 单口出，三引擎同链（claude preset append / codex AGENTS.md / zcode AGENTS.md）。
- 无绑定 agent 也注入框架句+身份两节（本次事故的最小根治）；有绑定时责任应用节自动出现。「你是干什么的」的正确答案从此**派生自绑定**，不依赖用户手写 systemPrompt。

## 5. 能力面（工具）

- `donger-apps` 维持「全员挂载+会话用户闭包」不变（`orchestrator.ts:571` 现状即合理：用户闭包已是数据边界）。
- **app_create 自动落绑定**：`createAppToolsServer` 闭包增加 `agentId`（挂载点 `p.agent` 在手），create 成功即 `managerAgentId = 当前 agent`。应用管家创建的应用天然自绑定；用户后建 agent 接管时在 UI 改派。
- `app_deploy` / `app_publish` 成功路径发射事件（§6），fire-and-forget、fail-open，同 `feedback.created` 惯例。
- `app_logs_tail`（拍板点④，可选）：读 `app_logs`（level=error 过滤、≤100 条、appId 必须在用户闭包内）——补齐管家「发现错误→修→发→验证」的验证腿。

## 6. 事件闭环（复用触发器+通知，零新机制）

### 6.1 事件词表（EVENT_TRIGGER_NAMES 追加，注册表本为此设计）

| 事件 | payload 契约（发射方=app-tools） |
|---|---|
| `app.published` | `{appId, name, version, previousVersion, publishedBy: {kind: "agent"\|"user", agentId?}, managerAgentId, at}` |
| `app.rolled_back` | `{appId, name, from, to, managerAgentId, at}` |

matcher 全用现有 8 种 kind（如 `jsonPathEq $.app.appId`、`always`），队列/泵/at-least-once 语义原样继承。

### 6.2 通知目录（NotificationEvent + catalog 登记，fail-closed 惯例）

- 新组 `"app"`：`app.published`（info，owner 收：发布完成+运行路径+版本）、`app.rolled_back`（warn，owner 收：回滚告警+当前版本）。组粒度订阅偏好矩阵（站内信恒开/dingtalk/webhook opt-in）直接复用。
- 深链：通知详情跳应用运行页/版本历史（通知详情深链机制 c848a39 已有）。

### 6.3 触发器用法样例（无人值守自动化，admin-only M1 约束不变）

- 「发布后自动冒烟」：event trigger（`app.published`）→ loop 跑验证 prompt（打开 /apps/&lt;id&gt;/ 截图比对）→ 结果进 loop_runs+通知。
- 「回滚即外呼」：`app.rolled_back` matcher → webhook 通道通知运维群。

## 7. 反馈接入应用（M2，拍板点③）

- `feedback_items` 加 `appId TEXT`（弱引用）：应用详情页/运行页「反馈」入口带入；平台级反馈留空。提交校验：提交者须 owns 该 app（apps 均为 private，天然 owner 闭包）。
- `feedback.created` payload 增补 `appId`；路由规则：
  - **M2a 通知腿**：有管家 app 的反馈 → 站内信通知管家 agent 属主（复用 feedback.replied 通道形态）；
  - **M2b 接单腿**（admin 配置的 event trigger → loop）：loop 的 agent 即管家（loop 绑定 workflow，workflow 选管家 agent），payload wrapUntrusted 注入接单 prompt，产出会话 `agentConversationId` 回写反馈 `conversationIds`（反馈对话化已支持指针）。
- 闭环终点判定：反馈 `resolved` 且该 app 出现新版本（两个事实在通知文案中并列呈现）。
- 越权面：appId 弱引用读时降级；触发器 payload 含他人反馈正文的既有风险面不变（admin-only 拦截）。

## 8. UI 面

- 应用详情/运行页：管家徽标 + owner 改派下拉（agent 候选=本人 agents + 内置应用管家）。
- agent 编辑器：「管理的应用」区（反查只读列表 + 「接管/让出」动作，写 apps 表）。
- 会话顶栏：绑定 app 的会话在身份徽标旁显示「管家·{app.name}」（身份模型轮已有 sdkType 徽标位）。

## 9. 安全与治理

- 全部动态内容（agent name/description、app 元数据、事件 payload）过 `wrapUntrusted` 定界；框架句在包裹外。
- 改派越权：非 app owner 改派 403；指向越权 agent 的绑定读时降级为兜底管家。
- 风暴面：app.published 频率=发布频率（人为低频），不做节流；队列 7 天清理沿用 `cleanupBefore`。
- 审计：事件发射、绑定变更、改派均落 system_events/audit 既有面。

## 10. 分期

| 期 | 内容 | 依赖 |
|---|---|---|
| P0（独立先行） | zcode runner 提示链修复 + 最小身份节（框架句+name/description） | 无；直接根治本次事故 |
| P1 闭环主骨架 | managerAgentId 绑定+校验+自动落绑定、责任应用节派生、app.published/rolled_back 事件+通知、UI 改派 | P0 |
| M2 反馈接应用 | feedback.appId + 通知腿 + 接单腿 + 闭环终点判定 | P1 |
| 可选 | app_logs_tail、自动冒烟 loop 模板、应用健康事件（error 率阈值） | P1 |

## 11. 拍板点

1. **绑定真源 app 侧**（推荐，理由 §3.1）vs agent 侧；
2. 单管家+内置兜底（推荐）vs 多管家带角色；
3. 反馈绑 app 是否进 M2（推荐进，通知腿先行）；
4. `app_logs_tail` 是否随 P1（推荐随，管家闭环缺验证腿）；
5. P0 是否不等本设计、单独先行合入（**强烈推荐**：事故根因在等你）。

## 12. 测试与验收

- 单测锚点：绑定校验（owner 闭包/弱引用降级/兜底路由）、身份节含责任应用清单且在用户 systemPrompt 之前、事件 payload 契约、通知目录 fail-closed、app_create 自动绑定、zcode runner 写 AGENTS.md。
- 验收样板（maycur 场景重放）：
  1. 问「你是干什么的」→「我是 donger 平台上的『maycur-ai-coplit-app』智能体，负责管理应用『maycur-ai-copilot』（/apps/&lt;id&gt;/，当前 v3）」；
  2. app_publish 回滚 → owner 收 warn 通知，触发器可命中；
  3. （M2）应用页提交反馈 → 管家接单会话生成（绑管家 agent）→ 修复重发布 → 反馈 resolved+新版本双事实通知提交人。
