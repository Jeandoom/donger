# 平台消息订阅与工作流处理闭环设计（钉钉 / Teambition）

> 2026-10-27 设计交付，待拍板未动码。
> 场景：钉钉/TB 平台的信息接收 → 工作流处理 → 回复处理结果的逻辑闭环。
> 路线：连接器/事件完成消息订阅，工作流完成消息处理和回复——全部实例化既有抽象，不造平行子系统。

---

## 1. 目标与验收样板

两个验收样板（用户场景的具象化）：

**样板 A（钉钉群）**：项目群里 @机器人「帮我分析一下这份周报数据」→ 秒回「已受理」（可选）→ 事件命中订阅规则 → 工作流以订阅者身份跑 agent 会话 → 完成后结果回复到该群。

**样板 B（Teambition）**：TB 项目中某任务被标记高优/新增评论 → TB Webhook 推送到平台 → 事件命中订阅规则 → 工作流跑 agent（可经 TB MCP 连接器拉任务详情、写评论）→ 完成后确定性兜底：结果以任务评论形式回复到源任务（+可选钉钉群播报）。

**非目标（本轮不做）**：钉钉私聊对话语义改造（现状保留）；TB 操作面平台级工具封装（走 MCP 连接器零平台代码）；向量/富媒体消息处理。

---

## 2. 生态方案对照与可行性结论

### 2.1 钉钉侧（官方能力实证）

| 能力 | 结论 | 依据 |
|---|---|---|
| 机器人消息（单聊+群@） | 同一 `TOPIC_ROBOT` 回调，`conversationType` 1=单聊 2=群聊；群消息含 senderStaffId/sessionWebhook | [机器人接收消息](https://open.dingtalk.com/document/group/receive-message) |
| 平台事件订阅 | Stream 模式同一长连接推送（签到/审批/通讯录/TB 任务属性变更等），事件类型在开发者后台勾选，代码无需指定 topic（`TOPIC_EVENT`） | [事件订阅总览](https://open.dingtalk.com/document/development/org-event-overview)、[Stream 事件订阅教程](https://open-dingtalk.github.io/developerpedia/docs/explore/tutorials/stream/event/python/build-listener) |
| 群回复 API | `POST /v1.0/robot/groupMessages/send`（robotCode + openConversationId + msgKey/msgParam），持久的主动发送，暂不支持 @ 功能 | [机器人发送群聊消息](https://open.dingtalk.com/document/development/the-robot-sends-a-group-message) |
| **sessionWebhook 坑** | 随消息下发的回复地址**有效期约 30 秒**；长任务异步回复必须走 OpenAPI，否则静默丢失。社区项目同款 issue 实锤 | [sessionWebhook 过期问题](https://github.com/soimy/openclaw-channel-dingtalk/issues/319)、[机器人回复/发送消息](https://open.dingtalk.com/document/dingstart/robot-reply-and-send-messages) |
| SDK | 现用 `dingtalk-stream@2.1.6-beta.1`（package.json:49）即官方 Node Stream SDK，`DWClient.registerCallbackListener` 同实例可注册多 listener | 现状代码 `src/adapters/dingtalk-channel.ts:40-67` |

**可行性结论**：入站（群消息+平台事件）与出站（群回复）全部走现有 Stream 连接 + OpenAPI，**零新增公网暴露、零新增第三方依赖**。

### 2.2 Teambition 侧（官方能力实证）

| 能力 | 结论 | 依据 |
|---|---|---|
| Webhook 事件推送 | 企业自建应用可在开发者后台登记回调地址+勾选事件类别（任务/项目等），HTTP POST JSON 推送；**须 5 秒内 200**，否则进入持续重试（指数退避，最长可达 6 天），多次失败 Webhook 会被标记不可用 | [企业自建应用 Webhook 推送](https://open.teambition.com/docs/documents/5f59d997a41fa4001689158d) |
| 请求签名与防环 | header 含 `X-Signature`（body 签名）、`X-Request-Id`、`X-Tenant-Id`、`X-Trigger-From-Me`（本次事件是否由当前订阅应用自身动作触发——天然防环信号） | 同上 |
| 推送粒度 | **全企业范围**推送（如订阅任务类=企业内所有任务变动都推），官方明示「消费端过滤」 | 同上 |
| 操作面 | TB 官方 MCP Server（open.teambition.com/user-mcp，QueryProjectsV3/CreateTaskCommentV3 等全套 V3 能力）→ 平台现有 **mcp 连接器直接可用**；REST V3（corpAccessToken）供平台级确定性回复 | [TB 开放平台](https://open.teambition.com/docs)、本机 `tb` 技能清单 |
| 备选入站 | TB 任务属性变更也可经钉钉事件订阅推送（TB 与钉钉同属阿里系），但自建 Webhook 更直接、事件更全 | [钉钉事件订阅总览](https://open.dingtalk.com/document/development/org-event-overview) |

**可行性结论**：TB 入站=Webhook（一个平台级验签端点，5 秒 200 与本平台「入队+泵」异步模型天然契合）；出站回复=REST V3 评论；agent 操作面=TB MCP 连接器（既有能力，零平台代码）。

### 2.3 社区同类方案参照

- **n8n / Zapier / IFTTT**：触发器（trigger：webhook/polling/app event）→ 处理流 → 动作（action：回帖/发消息）。与本平台「事件→工作流→通知」同构；差异在于本平台处理单元是 agent 会话而非 DSL 节点——业务逻辑进 agent 与技能，符合平台既定理念。
- **飞书开放平台事件订阅**：业界最成熟的「推送+验签+challenge+卡片回调」范式；其「事件订阅与长连接模式」与钉钉 Stream 同型，卡片异步更新对应本方案「受理 ack + 完成回复」两段式。
- **GitHub Actions / GitLab Webhook**：webhook 以仓库属主身份、queue 异步执行、防环（bot 产生的事件不回流触发）——对应本方案 D4（执行身份）与 D5（防环）。

---

## 3. 现状盘点与缺口（复用面清单）

| 环节 | 现状（复用） | 缺口 |
|---|---|---|
| 钉钉入站 | `DingTalkChannel` Stream `TOPIC_ROBOT`（`dingtalk-channel.ts:40-67`）；单聊走对话语义 | **群聊消息（conversationType=2）直接被当私聊对话处理，无「消息→事件」路由** |
| TB 入站 | 无 | 无任何接入 |
| 事件系统 | 三分法 `system/schedule/call`（`domain/event.ts:102`）+ `EventDispatcher.fire` 统一管线（入队+泵+级联上限+触发记录） | 无「外部平台推送」事件承载类型 |
| 工作流 | `eventId` 订阅→run→agent 会话→完成事件（`event-dispatcher.ts:235-328`） | 已满足，无需改 |
| 回复 | `notifyPolicy` 通知轮（`kind:"notify"`，写手产文案→兜底落库→多通道投递），通道 `inapp/dingtalk/webhook/email` | 缺「回复到触发来源」语义（钉钉群、TB 任务评论）；钉钉通知通道目前仅单聊 |
| 连接器 | mcp 连接器→agent mcpServers（`runtime-manager.ts:579-610`），TB MCP Server 可直接挂 | 无缺口；TB 凭证走用户级连接器 |

**核心洞察**：缺的不是执行与回复骨架，而是两块「入站适配」与一个「回源语义」——

1. **消息事件化**：外部平台推送 → `EventDispatcher.fire`（新增事件类型承载）；
2. **回复回源**：工作流跑完 → 按触发时记录的「回复锚点」投回源平台；
3. TB 是全新平台接入（凭证+验签端点+评论出站）。

---

## 4. 架构设计

### 4.1 总图

```
┌─ 入站适配层（新）────────────────────────────────────────────┐
│ DingTalkChannel(TOPIC_ROBOT)                                 │
│   conversationType=1 单聊 → Orchestrator.handleMessage       │ ← 对话语义（现状不动）
│   conversationType=2 群@  ──┐                                 │
│ TB Webhook 端点(验签) ──────┤→ MessageEventRouter            │ ← 事件语义（新）
│ (扩展面)钉钉 TOPIC_EVENT ───┘   归一 payload                │
│                                 订阅预判+去重+防环           │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
        EventDispatcher.fire()  ←──  events 表新增 type="message"
        （触发记录→扇出→入队→泵）      既有管线零改动
                               ▼
        workflow run（agent 会话，执行身份=订阅 owner）
        prompt 变量：{{triggerOutput}}/{{data}}/{{message.*}}
                               ▼
        完成事件 → notifyPolicy 通知轮（既有）
        channels += "source"（新）：按 FireContext.replyAnchor 回源
          ├─ dingtalk_group → /v1.0/robot/groupMessages/send（新）
          ├─ teambition_comment → TB REST V3 评论（新 util）
          └─ inapp/dingtalk/email/webhook（既有）
```

架构不变式：**入站适配只做「归一+路由」，不做业务；回复只走通知轮既有机制**。事件语义与对话语义在通道层分叉，事件系统不感知平台差异（平台差异全部收敛在 payload 契约与 replyAnchor）。

### 4.2 D1：消息事件化——事件新增第四类 `message`

对齐 `domain/event.ts` 现有 schema 风格：

```ts
// domain/event.ts 追加
export const MESSAGE_PLATFORMS = ["dingtalk", "teambition"] as const;

export const EventMessageConfigSchema = z.object({
  platform: z.enum(MESSAGE_PLATFORMS),
  /** 钉钉：robot 消息 topic（M1）；后续可扩事件订阅 topic。TB：webhook 事件类型 */
  topic: z.string().min(1).max(128),            // dingtalk: "robot.group"；teambition: "task.update"/"task.create"/"task.comment"…
  /** 收窄条件（消费端过滤，TB 全企业推送必配） */
  filter: z.object({
    openConversationId: z.string().optional(),   // 钉钉群
    orgId: z.string().optional(),                // TB 企业
    projectId: z.string().optional(),            // TB 项目
    allowFrom: z.array(z.string()).optional(),   // 发起人白名单（senderStaffId / TB 成员 id）
  }).optional(),
  matcher: TriggerMatcherSchema.optional(),      // 既有 JSON matcher 兜底细粒度判定
});
```

- `type: z.enum(["system","schedule","call","message"])`，`message` 配置项与 refine 同构补齐；
- `EventFireSource` 增 `"message"`；`WorkflowRun.eventName` 天然容纳；
- 事件页 UI 复用现有表单模式（类型新增一档，钉钉群下拉取自配置的群列表，TB 事件类型下拉枚举）。

**为什么不是归入现有类型**：`call` 是「per-event 随机 path 的入站 HTTP」，语义是「外部系统定向回调这一个 hook」；钉钉/TB 推送是「平台级单端点、多订阅规则扇出」，且订阅规则需要平台收窄字段与去重语义。混入 `call` 会把验签/防环/去重/平台枚举塞进 hook 语义，污染面大；独立 `message` 类型保持三分法各自的单一职责，四分法（system/schedule/call/message = 进程内/定时拉/回调推/平台推）语义完整。

### 4.3 D2：payload 契约与提示词变量

对齐 `event-payloads.ts` 现有 envelope 风格，新增 `buildPlatformMessagePayload`：

```ts
// 统一信封（payload JSON，{{triggerOutput}} 原文；对象形态进 {{data}}）
{
  platform: "dingtalk" | "teambition",
  topic: "robot.group" | "task.update" | ...,
  eventId: "tb 原生 eventId / 钉钉 msgId",     // 去重键
  occurredAt: ISO 时间,
  sender: { id, name },                        // senderStaffId / TB 成员
  source: { openConversationId?, conversationType?, orgId?, projectId?, taskId? },
  text: "消息正文 / 事件摘要",                 // wrapUntrusted 在渲染管线统一做（现状不变）
  raw: { …平台原始裁剪 }                       // 保留排障面，敏感字段脱敏
}
```

`FireContext` 扩展（对齐 `query/data` 的可选字段风格）：

```ts
export interface FireContext {
  payload: string;
  query?: string;
  data?: Record<string, unknown>;
  /** 平台消息事件专用：事件去重键 + 回复锚点（见 D3） */
  messageMeta?: { eventId: string; platform: string };
  replyAnchor?: ReplyAnchor;
}
```

工作流 prompt 模板即拥有 `{{triggerOutput}}`（信封原文）与 `{{data}}`（美化 JSON）两个既有变量，存量模板零迁移。

### 4.4 D3：回复回源——notifyPolicy 通道语义扩展 + 出站适配

**语义**：`notifyPolicy.channels` 白名单新增枚举值 `"source"`（回复到触发来源）。

```ts
// domain/workflow.ts NotifyPolicySchema.channels
// "inapp" | "dingtalk" | "webhook" | "email" | "source"
```

- `FireContext.replyAnchor` 在消息事件 fire 时构造（`{ platform, kind, anchor }`），随 run.context 持久化；
- 通知轮 `executeNotifyRun` 投递时：`channel==="source"` 且 run 携带 anchor → 走对应出站适配器；无 anchor（如手动运行）→ 降级 `inapp` 并在投递日志标注；
- **回复主通道=确定性兜底**（沿用反馈回复轮 4a3fcc9 的经验：写手产出文案，平台确定性投递，不让回复成败取决于 agent 工具调用）。

**出站适配新增两处**：

1. **钉钉群回复**：`util/dingtalk-api.ts` 增 `sendGroupMessage(openConversationId, robotCode, markdown)` → `POST /v1.0/robot/groupMessages/send`（复用 `getAccessToken` 缓存）。不使用 sessionWebhook（30 秒有效期，长任务必丢，见 §2.1）。
2. **TB 任务评论**：新 `util/teambition-api.ts`（corpAccessToken 获取+缓存 → `CreateTaskCommentV3` REST 对应端点）。凭证 = 平台级 TB 应用（见 D7）。

**可选增强（M3）**：平台工具 `platform_reply`（写手主动补发/多轮），以及 agent 经 TB MCP 连接器直接评论（操作面本来就该走 agent——平台兜底与 agent 操作是两轨，不互斥）。

### 4.5 D4：执行身份与安全边界

- 工作流执行身份 = **订阅 owner**（与既有 system/schedule/call 事件完全一致，`execute()` 现状零改动）；消息发起人只进 payload 上下文与回复 @ 对象，不改变执行身份。
- 理由（安全）：群内任何成员 @机器人都不应透传 owner 的 agent 权限（full_access 缺省下尤其危险）；与 GitHub Actions「webhook 以仓库属主身份」同型。
- 高优配套：`filter.allowFrom` 白名单一等字段（钉钉 senderStaffId / TB 成员 id），订阅创建 UI 提示「群内成员均可触发本工作流」；权限模式建议订阅创建时默认 `risk_guard` 提示项（不强制，尊重工作流配置即权限的既定拍板）。
- TB Webhook 验签 fail-closed（`X-Signature` 校验失败 401，参照 `release-webhook.ts` 三平台验签既有模式）；订阅规则未命中（无 enabled 的 message 订阅匹配）→ 200 快速空应答，不入队。

### 4.6 D5：防环

- **TB**：出站评论动作由平台 TB 应用发起 → TB 回推事件带 `X-Trigger-From-Me: true` → MessageEventRouter 直接丢弃该类事件（一等防环）；兜底：`MAX_CASCADE_DEPTH=5` 既有级联上限。
- **钉钉**：机器人消息只在被 @ 时回调，机器人自己发的群消息不回流——天然无环；工作流若经 TB MCP 写 TB，则回到上一条防环路径。

### 4.7 D6：可靠性与容量

| 项 | 设计 |
|---|---|
| 快速 ACK | TB 5 秒 200 硬约束 ↔ `fire()` 本身就是「落记录→入队→立刻返回」——**架构天然契合**，端点只做验签+归一+fire；钉钉 Stream 回调同样先 ACK 再异步（SDK 回调返回 success 即 ACK） |
| 去重 | TB 重试语义=at-least-once：按 `platform+eventId` 在 firing 表做窗口查重（如 10 分钟），重复丢弃 |
| 噪音控制 | **订阅预判前置**：message 事件 fire 前先查 `listEnabledByPlatform(platform, topic)`，无订阅者直接短路（TB 全企业推送必须，否则 firing 表与队列被噪音灌满）；`filter`/`matcher` 命中后才入队 |
| 队列容量 | `EVENT_QUEUE_CAPACITY=10` 全局共享（`event-dispatcher.ts:73`）维持不变，但参数化为 `DONGER_EVENT_QUEUE_CAPACITY` 环境变量（缺省 10）；高频 TB 场景由部署方调大。工作流同 workflow 串行认领已有（`claimNextRunnable`），单订阅风暴不会并发挤兑 LLM |
| 断线恢复 | 钉钉 Stream SDK 自带重连；TB 重试兜底；`restore()` 启动恢复既有 |

### 4.8 D7：凭证分层（对齐既有架构）

| 层 | 归属 | 用途 | 落点 |
|---|---|---|---|
| 平台级 | `module_configs` 新键 `"teambition"`（appKey/appSecret/orgId，AES-GCM 加密，管理端授权页配置，应用即生效对齐钉钉换血模式） | TB webhook 验签（app 维度）+ 确定性评论出站（corpToken） | `sqlite-module-config-store.ts` + 授权页 UI + `applyTeambitionController` |
| 用户级 | **mcp 连接器**（TB MCP Server URL + 用户 token，`{{credential:…}}` 引用既有） | agent 会话内操作 TB（查任务/写评论/改状态） | 既有连接器能力，零平台代码 |
| 钉钉 | 既有 `module_configs.dingtalk`（appKey/appSecret/robotCode） | 群消息收发复用同一应用 | 无改动（权限点需在钉钉后台补「群消息发送」） |

钉钉群聊需运营侧动作：机器人加入目标群；钉钉后台补申请群消息发送权限。

### 4.9 D8：插件化与门禁

- 钉钉群消息路由：挂在既有 `channel.dingtalk` capability 内（停用=群消息不路由，配置写入 409 对齐现状）；
- TB 接入：新 capability 插件 `platform.teambition`（requires=["events","connectors"]，stoppable=true，对齐 `channel.dingtalk` 的 requires 门）；
- `message` 事件类型本身随 `events` 插件发放，UI 按已启用平台动态出选项。

---

## 5. 分期实施

| 期 | 内容 | 规模感 |
|---|---|---|
| **M1 钉钉群消息闭环** | 事件 `message` 类型（schema+store+API+事件页 UI）；DingTalkChannel 群消息分路由+MessageEventRouter（预判/去重/白名单）；`sendGroupMessage` 出站；notifyPolicy `"source"` 通道+通知轮接线；e2e（fire→run→回复群+inapp 降级） | 单通道最小闭环，事件系统管线零改动 |
| **M2 Teambition 闭环** | `module_configs.teambition`+授权页区块+运行时换血；验签端点（对齐 release-webhook 模式）；TB payload 归一+评论出站 util；`X-Trigger-From-Me` 防环；e2e（验签→fire→run→评论回任务） | 新平台接入主体 |
| **M3 增强（按需拍板）** | 钉钉 `TOPIC_EVENT` 事件订阅类扩展（审批/通讯录，同 `message` 类型加 topic）；TB MCP 连接器模板技能（含「分析任务→评论回复」recipe）；受理 ack 快速回执；队列容量 env 参数化；平台 `platform_reply` 工具 | 均为独立可后置项 |

---

## 6. 验收清单（e2e 样板）

1. **钉钉群**：群里 @机器人 → 秒回受理（若开）→ 订阅命中 → run 建 ⚙️ 会话执行 → 结果 `groupMessages/send` 回群（含 markdown）→ 事件页 firing 记录+run 记录齐全。
2. **降级**：手动运行该工作流（无 anchor）→ `"source"` 通道降级 inapp，投递日志可见。
3. **TB**：后台登记 webhook → 任务更新 → 验签通过 200<5s → 订阅命中 → run 执行（agent 可经 TB MCP 连接器拉详情）→ 完成后评论回到源任务；`X-Trigger-From-Me` 事件被丢弃（日志可见）。
4. **安全**：非白名单成员 @机器人 → 不触发；验签失败 → 401；无订阅者 → 快速 200 空应答不入队。
5. **稳定性**：TB 重试同 eventId 重推 → 去重只跑一轮；队列容量溢出 → failed 落行不丢记录。

---

## 7. 决策点（已拍板 2026-10-27）

| # | 决策 | 拍板 |
|---|---|---|
| D-A | 事件承载：新增第四类 `message`（四分法）vs 挤入 `call`/`system` | **新增 `message`** |
| D-B | 回复主通道：notifyPolicy `"source"` 确定性兜底 vs agent 工具主动回 | **`"source"` 确定性为主**，agent 操作（TB MCP 连接器）并存 |
| D-C | 群消息默认权限：订阅创建时是否强制 `allowFrom` 白名单/默认 `risk_guard` | **不强制**，UI 强提示+白名单一等字段 |
| D-D | TB 凭证归属：平台级 module_configs vs 用户级连接器 | **两层并存**：订阅/验签/兜底回复=平台级；agent 操作面=用户级 MCP 连接器 |
| E-A | M1/M2 分期范围与顺序 | M1 先行（技术验证后进入实施） |
| E-B | M3 哪些纳入首轮 | 建议仅「队列容量参数化」随 M1 顺手做，其余后置 |

---

## 9. 技术验证记录（2026-10-27）

### 9.1 钉钉侧（代码核证 + 生产凭证实测，脚本 `scripts/tmp-spike-dingtalk.mts`）

| 假设 | 验证方式 | 结果 |
|---|---|---|
| 群回复 API 权限 | 生产库读 module_configs.dingtalk 解密 → gettoken 实测 → `POST /v1.0/robot/groupMessages/send` 假 openConversationId 探测 | ✅ **gettoken 成功；返回 HTTP 400 `invalid.openConversationId`（参数错误而非权限错误）= 鉴权通过且群消息发送权限已具备**。基线对照 `oToMessages/batchSend` 返回 `staffId.notExisted`，错误形态可比对成立 |
| SDK 事件订阅能力 | 读 `dingtalk-stream@2.1.6-beta.1` 源码/类型 | ✅ 默认订阅即含 `{type:"EVENT", topic:"*"}`；`registerAllEventListener` 收全部事件（`headers.eventType/eventId/eventCorpId` 一等元数据）、`registerCallbackListener` 按话题精确路由，**同一 DWClient 实例可并存**；无 TOPIC_EVENT 常量也不需要 |
| 回调字段面 | 读 `RobotMessageBase` 类型定义 | ✅ conversationId/conversationType/senderStaffId/senderNick/isAdmin/sessionWebhook/sessionWebhookExpiredTime/msgId/robotCode 全在；**类型里无 openConversationId**——群回复所需群 ID 来源待实测（§9.3） |
| sessionWebhook 短时效 | 类型字段 `sessionWebhookExpiredTime` 存在 | ✅ 证实「异步回复必须走 OpenAPI」的设计判断 |
| Stream 回调重试语义 | SDK 注释与 `socketCallBackResponse` | ✅ 60 秒内未响应服务端重推 → fire() 必须同步快返回、先 ACK 后异步，与设计一致 |

### 9.2 TB 侧（官方文档核证，Apifox 镜像站 `teambition.apifox.cn` 可静态抓取，附 llms.txt 全目录）

| 假设 | 文档 | 结果 |
|---|---|---|
| Webhook 签名算法 | [Webhook请求合法性验证](https://teambition.apifox.cn/doc-387242) | ✅ `X-Signature = HMAC-SHA256(原始body, 应用秘钥)` 的 hex 串，官方 Node 示例即 `crypto.createHmac('sha256', secret).update(data).digest('hex')` |
| 出站鉴权 | [授权凭证](https://teambition.apifox.cn/doc-385312) | ✅ **appAccessToken = 本地 JWT 自签**（HS256，payload `{_appId, iat, exp}`，建议 1h 有效），无 token 换取端点；请求头 `Authorization: Bearer <jwt>` + `X-Tenant-Id: <orgId>` + `X-Tenant-Type: organization` |
| 任务评论 API | [评论任务](https://teambition.apifox.cn/api-61440110) | ✅ `POST https://open.teambition.com/api/v3/task/{taskId}/comment`，body `{content}`，返回动态详情；权限 `tb-core:task:update` 系 |
| Webhook 事件目录 | Webhook 目录（doc-387241..387288） | ✅ 任务创建/更新/删除、评论触发、日程、企业、部门、项目、关联、文件、应用安装/卸载/启停；body 结构 `{orgId, timestamp, event, eventId, hookId, data:{operatorId, task:{taskId, projectId, content, executorId, isDone…}}}` |
| 建立/重试/心跳 | [Webhook 推送建立](https://teambition.apifox.cn/doc-387241) | ✅ 后台加接收 URL + 应用事件加资源权限（如 task.update）→ 发布 → 企业安装后全企业推送（消费端过滤）；两种重试策略（5 秒 200 不重试 / 指数退避最长 6 天后标不可用）+ 心跳上报 + 重启中断推送 API |

### 9.3 结论与剩余实测项

**无阻塞性风险，可进入 M1 实施。** 剩余两项需真实环境配合（不阻塞开发，可在联调阶段完成）：

1. **钉钉群回调群 ID 实测**：把机器人拉进测试群 @ 一次，dump `TOPIC_ROBOT` 回调数据，确认群场景 `conversationId` 是否可直接作 `openConversationId`（社区惯例可行，类型定义未覆盖）。可选验证方式：`npx tsx scripts/tmp-spike-dingtalk.mts --stream-dump`（短连 Stream 收消息打字段；注意与生产通道分流，60 秒窗口内单聊消息可能被本地客户端抢收）。
2. **TB 应用创建与 webhook 联调**：需要 TB 企业管理员创建自建应用（App ID/AppSecret）、登记 webhook 接收地址、勾选 task.update/task.create 等事件权限并发布——平台侧凭证实测（签名对拍/评论回写）随 M2 联调进行。

## 8. 附录：代码落点清单（M1+M2）

| 落点 | 文件 |
|---|---|
| 事件 schema 四分法 | `src/domain/event.ts`（枚举+EventMessageConfigSchema+refine+FireSource） |
| payload 契约 | `src/domain/event-payloads.ts`（buildPlatformMessagePayload+replyAnchor 类型） |
| fire 管线（预判/去重/anchor 透传） | `src/orchestrator/event-dispatcher.ts`（fire/execute/executeNotifyRun 局部） |
| 钉钉群消息分路由 | `src/adapters/dingtalk-channel.ts`（conversationType 分叉+MessageEventRouter 新文件） |
| 钉钉群回复 | `src/util/dingtalk-api.ts`（sendGroupMessage） |
| TB 平台接入 | `src/domain/module-config.ts`、`src/adapters/sqlite-module-config-store.ts`、`src/util/teambition-api.ts`、webhook 端点（对齐 `src/domain/release-webhook.ts` 验签模式）、`src/index.ts` 装配+换血控制器 |
| 通知通道 | `src/domain/workflow.ts`（channels+"source"）、通知投递分流处 |
| 插件 | `plugins/builtin/platform.teambition/plugin.json`（新）；`channel.dingtalk` 无需改 |
| UI | 事件页 message 表单、授权页 TB 区块、通知通道选项 |
