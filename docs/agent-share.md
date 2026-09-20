# 智能体分享功能说明

智能体创建者可以通过一条链接把自己的智能体共享给平台内其他用户使用。被分享者能用它对话，但看不到也改不了它的配置。本文说明该功能的完整链路、权限口径与 API。

## 功能定位

- 分享单元是**智能体**（Agent），不是单条会话；被分享者获得的是「使用该智能体对话」的资格。
- 授权载体是**带 token 的链接**：`{origin}/share/{token}`。拿到链接并登录成功的用户即被授权（记入访问者名单），无需分享者逐个添加。
- 权限分层明确：被分享者只获得**使用**（canUse），不获得**管理**（canManage）——无权查看完整配置、无权编辑、无权删除、无权管理分享本身。

## 权限口径

判定函数在 `src/domain/agent-policy.ts`：

| 函数 | 判定 | 用途 |
| --- | --- | --- |
| `canManageAgent` | `role === "admin"` 或 `agent.ownerId === user.id` | 开/关分享、查看访问者名单、移除授权、编辑/删除智能体 |
| `canUseAgent` | `canManageAgent` **或** `isGranted(agentId, userId)` | 获取智能体详情、建立会话、发送消息、@ 引用候选、读版本历史 |

`isGranted` 由 `agent_share_grants` JOIN `agent_shares`（且 `enabled = 1`）判定——**关闭分享后名单虽保留，但所有授权立即失效**；重新开启后原链接与原名单一并恢复。

## 数据模型

`src/adapters/sqlite-agent-share-store.ts`，两张表（`src/index.ts` 启动时 `migrate()`）：

- `agent_shares`：`agentId`（主键，每个智能体最多一条）、`token`（UUID，唯一）、`enabled`、`createdAt`。
- `agent_share_grants`：`(agentId, userId)` 联合主键、`grantedAt`。

token 语义：

- 首次开启分享时生成 UUID，之后**不再轮换**——关闭分享只置 `enabled = 0`，token 与链接不变；再次开启后原链接继续可用。
- 关闭分享不清空 `agent_share_grants`，访问者名单保留。

## 分享者操作

入口在智能体编辑页「集成」区块（`web/src/pages/agent-editor/IntegrationSection.tsx` 的 `SharePanel`）：

1. 点击「开启分享」→ 生成 token，展示完整分享链接（点击可全选复制），并出现「已授权 N 人」徽标。
2. 「访问者名单」列出所有已接受授权的用户 ID，可单独「移除」；移除后该用户立即失去使用资格（会话保留但无法继续对话）。
3. 点击「关闭分享」→ 链接与全部授权同时失效；界面提示语：「开启后通过链接授权的用户可使用本智能体对话，但无权查看或编辑配置。」

## 被分享者使用链路

1. **打开链接** `/share/:token` → 落地页 `ShareLandingPage`（`web/src/pages/ShareLandingPage.tsx`）。
2. **公开校验**：前端调 `GET /api/agents/by-share/:token`（守卫表中显式 public 的端点，token 自鉴权）。只返回 `agentId / name / description`，**不泄漏任何配置**。链接无效或已关闭 → 显示「分享链接无效或已失效」。
3. **登录衔接**：未登录时展示「登录后进入该智能体」（跳 `login?next=/share/:token`）；落地页监听 `storage` 事件，其它标签页登录成功（写入 `donger_jwt`）后自动继续授权流程。已登录则直接进入下一步。
4. **接受授权**：`POST /api/agents/:id/accept-share`（body 携带 token）——校验 token 有效且与 agentId 匹配后，幂等写入访问者名单（`INSERT OR IGNORE`），然后 get-or-create **该用户名下**与该智能体的会话，返回 `conversationId`。
5. **进入对话**：前端跳转 `/agents/{agentId}/chat`，用刚创建的会话正常对话。
6. **列表呈现**：`GET /api/agents` 会把 `listSharedWith(userId)`（grants JOIN shares 且 enabled）并入返回，标记 `_mine: false`；智能体页「分享给我的」分组展示这些智能体（`web/src/pages/AgentsPage.tsx`）。

## 后端 API 一览

| 方法与路径 | 守卫 | 权限 | 作用 |
| --- | --- | --- | --- |
| `GET /api/agents/by-share/:token` | public | 无（token 自鉴权） | 落地页公开校验，仅返回 id/name/description |
| `GET /api/agents/:id/share` | authenticated | canManageAgent | 查询分享状态（enabled/token/url）与访问者名单 |
| `POST /api/agents/:id/share` | authenticated | canManageAgent | 开启（`{enabled:true}`，返回 token 与 url）/ 关闭分享 |
| `DELETE /api/agents/:id/share/grants/:userId` | authenticated | canManageAgent | 从名单移除单个用户 |
| `POST /api/agents/:id/accept-share` | authenticated | 本人 + token 校验 | 接受分享：幂等写名单 + get-or-create 会话 |

另有两处消费点：`GET /api/agents/:id/conversation`（会话入口）与 orchestrator 发消息路径 `resolveAgentForUse` 均按 `canUseAgent` 判定，被分享者与所有者口径一致。

## 运行时细节（被分享者视角）

- **会话隔离**：会话建在被分享者自己名下，消息读写按会话属主隔离，与所有者的会话互不可见。
- **配置不可见**：非管理者调 `GET /api/agents/:id` 时返回 `editable: false`，DTO 只含 id/ownerId/name/description/时间戳等基础字段——systemPrompt、技能、连接器、凭证、Git 仓库等配置一律不下发。
- **技能归属**：被分享场景下 orchestrator 以智能体属主身份解析技能（`sharedAgentSkillOwner`，见 `src/orchestrator/orchestrator.ts`），技能行为与所有者使用时一致。
- **Git 仓库凭证按使用者解析**：`gitAccessGate.check(user, agent)` 用被分享者本人的凭证；缺失时返回 `gitBlocked`，对话入口提示「请先完成智能体所需 Git 仓库授权后再对话」。
- **编辑与删除仍被拦截**：`PATCH / DELETE /api/agents/:id` 与 share 管理路由都要求 `canManageAgent`，被分享者一律 403。

## 边界行为

- **内置智能体不可分享**：内置智能体是代码常量不入库，share 路由查 `agentStore.get()` 即 404，天然不可分享。
- **删除智能体**：`agent_shares` / `agent_share_grants` 不级联删除，但智能体已不存在，链接与授权自然失效（列表 JOIN 查不出、by-share 404）。删除确认文案「历史会话与分享链接将保留但不再可用」与此一致。
- **重复接受授权**：`accept-share` 幂等，同一用户多次点链接不会产生重复名单或重复会话（复用已有会话）。
