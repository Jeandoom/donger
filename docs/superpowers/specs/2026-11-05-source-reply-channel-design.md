# 通知通道「回复来源」（source 回源）重新设计

- 日期：2026-11-05
- 状态：**已并入统一设计（2026-11-05-unified-notification-channel-system-design.md §2.6）——回源场景由该稿覆盖，本文保留作锚点模型/通道可行性细节参考**
- 触发：TB bug 自动分析通知轮配置错配复盘（见对话记录）暴露 source 通道的系统性缺口
- 关联：2026-10-27-platform-message-subscription-design（锚点/路由）、2026-10-20 反馈闭环 M2/M3（notifyPolicy）、notification-module-design（站外通道）

## 0. 一句话

把「回复来源」从 event-dispatcher 里的硬编码 if/else + domain 判别联合，重构为**自描述锚点信封 + 可注册的回源适配器契约**：入站通道只负责在事件信封里带锚点，出站只认注册表；新通道接入 = 实现一个适配器 + 注册一行，零核心类型改动。

## 1. 现状锚点（读码结论，file:line 均为 master 1c0de3dd）

### 1.1 现有实现

| 部件 | 位置 | 现状 |
|---|---|---|
| 锚点类型 | `src/domain/event.ts:208` | 判别联合**硬编码两态**：`{platform:"dingtalk",kind:"group",threadId}` / `{platform:"teambition",kind:"task",taskId,orgId?}` |
| 锚点产生（钉钉群 @） | `src/adapters/dingtalk-channel.ts:51` | 信封带 `replyAnchor`，经 MessageEventRouter 随 run.context 持久化 |
| 锚点产生（TB webhook） | `src/domain/teambition.ts:68` | task.update 事件信封带锚点；**端点在（web-channel.ts:1429）但 hook 休眠**（无 workflow 绑定、TB 后台未配） |
| 锚点提取 | `src/domain/event-payloads.ts:310 extractReplyAnchor` | 只认 `payload.replyAnchor` 字段 |
| 出站投递 | `src/index.ts:734 sourceDeliver` | **硬编码 if/else**：dingtalk→`dtChannel.send(threadId)`；teambition→`createTaskComment`（app token，`src/util/teambition-api.ts:68`）；其他平台抛错 |
| 通知轮管线 | `src/orchestrator/event-dispatcher.ts:743-762` | source+锚点在场→投递；**无锚点→warn+降级 inapp**（source 不属通知服务通道枚举，强制补 inapp 已内建） |
| 投递失败处理 | 同上 `.catch(log)` | **仅日志，run 状态不反映**（回源失败在执行详情不可见） |
| 级联透传 | `event-dispatcher.ts:476` | execution.completed 信封**只透传 correlation，不透传 replyAnchor**——级联工作流想回原源会丢锚点 |

### 1.2 生产现状（2026-11-05 库内实证）

| 触发源（events 表） | 类型 | 有锚点 | 绑定工作流 | 状态 |
|---|---|---|---|---|
| 钉钉群@消息 | message/dingtalk | ✓ 群 threadId | 钉钉消息处理 | **在跑**（唯一真实 source 消费者，recipients=owner） |
| Teambition 消息 | message/teambition | ✓ taskId | （无绑定） | **休眠**（hook 未配） |
| TB bug 自动分析（30 分钟） | schedule | ✗ | TB bug 自动分析 | 在跑；其 source 通道配置**恒降级 inapp**（无锚点） |
| stock-analysis运维 | schedule | ✗ | stock-analysis运维 | 无通知策略 |
| 反馈已创建 / 反馈处理完成 | system | ✗（未建模） | 反馈自动修复·L2 | 反馈回走专用机制（feedback_add_reply + 确定性兜底），不经 source 通道 |
| （手动运行） | manual | ✗ | — | — |

## 2. 通道清单与逐一可行性验证

判定口径：**「回复来源」=结果回投到触发事件的原始位置**（群消息回群、任务评论回任务）。无"原始位置"语义的通道（定时、纯出站 webhook）天然不适用，列为排除而非支持项。

### 2.1 钉钉群（生产已验证 ✓）

- 入站：群机器人接收 @（60s ACK 重推去重已处理，message-event-router.ts 窗口查重）。
- 出站：`dingtalk-channel.send(threadId)` → 群机器人 groupMessages/send；机器人必须在群里（机器人配置即凭证，复用授权页 appKey/appSecret/robotCode）。
- **结论：可行，已在产线验证**。约束：threadId 永久有效（群不解散）；机器人被移出群=投递失败（可观测性见 §4-D2）。

### 2.2 Teambition 任务评论（代码已就绪 · 待端到端唤醒）

- 入站：TB webhook task.update（签名验证 `verifyWebhookSignature` 已备）；或 TB MCP 监听（现网 TB bug 分析的实路——但它业务轮内直接评论，不走通知轮）。
- 出站：`createTaskComment`（app access token + X-Tenant-Id，open API `/api/v3/task/{id}/comment`）。
- **结论：技术可行，风险两点**：①评论以**应用身份**发出（非个人身份，TB 侧显示 app 名）；②任务被删除/移出项目=投递失败。当前唯一缺口是 webhook 唤醒与端到端验证（见分期 M2）。

### 2.3 反馈单（in-app source · 设计选项）

- 现状：反馈链不走 source 通道——`feedback_add_reply` 工具 + 通知轮确定性兜底落回复（反馈闭环 M1/M3 已闭环，生产验证过：37fc7c31 回填）。
- 可选统一：把反馈单建模为锚点 `{platform:"donger",kind:"feedback",feedbackId}` 进 source 管线，替代专用兜底。
- **结论：可行但非必须**。专用机制已生产验证且带写边界（allowedFeedbackId 单反馈单授权）；统一进 source 的收益是架构一致，代价是迁移风险。建议维持现状，作为 M3 可选项（拍板点 D3）。

### 2.4 邮件线程（排除）

- 「回复来源」要求存在可回的原始会话；平台**无邮件入站**（email 是纯出站通知通道 notif-email），没有"源"可回。
- 若未来接邮件入站（IMAP/邮件 webhook），锚点形如 `{platform:"email",kind:"thread",messageId}`，出站补 In-Reply-To/References 头即可——适配器契约已覆盖此形态。

### 2.5 Webhook（排除）

- 纯出站 fan-out，无线程语义，`source` 对它无定义。维持现有 `webhook` 通知通道身份，不进入回源体系。

### 2.6 飞书 / 企业微信（预留 · 本期不实现）

- 飞书：若接入，锚点 `{platform:"lark",kind:"chat",chatId,messageId}`，出站 `im/v1/messages/{message_id}/reply`（机器人凭证），标准 REST，可行性高。
- 企业微信：群机器人 webhook 仅单向推送，回群需企微应用 API + 群会话标识，可行性中等。
- **两者都是"适配器契约 + 入站锚点声明"的例证**，本期只保证契约能装下它们（§4），不写实现。

### 2.7 汇总矩阵

| 通道 | 锚点形态 | 回信 API | 现状 | 本期动作 |
|---|---|---|---|---|
| 钉钉群 | group/threadId | 群机器人 groupMessages | 生产已验证 | 搬入适配器契约 |
| Teambition 任务 | task/taskId+orgId | open API 评论（app 身份） | 代码就绪、休眠 | 搬入契约 + M2 唤醒 |
| 反馈单 | (未建模) | feedback_add_reply/兜底 | 专用机制闭环 | 维持专用，M3 可选统一 |
| 邮件线程 | (无入站) | In-Reply-To | 无源可回 | 排除，契约预留 |
| Webhook | (无线程) | — | 无源可回 | 排除 |
| 飞书/企微 | (未接入) | 平台 API reply | 未集成 | 契约预留，不实现 |

## 3. 现状缺口清单（设计要解决的问题）

- **G1 开放闭合破坏**：新增回源平台需同时改 `domain/event.ts`（判别联合）+ `src/index.ts`（sourceDeliver if/else）两处核心代码。
- **G2 级联丢锚点**：execution.completed 信封只透传 correlation；钉钉消息→分析→级联下游→通知想回原群的场景无法成立。
- **G3 回源失败不可观测**：投递失败仅 `logger.error`，notify run 状态仍 success——执行详情看不到回源失败，与「 recipients 解析失败置 failed」的可见性不对称。
- **G4 锚点无治理**：入站信封的 replyAnchor 无注册表校验——未登记 platform 的锚点入站无人拦，到投递期才抛「不支持的平台锚点」。
- **G5 配置语义模糊**：recipients=correlation × 无锚点触发（TB bug 工作流实锤）恒降级+恒失败行（前一诊断轮已析，本设计不重复修，但降级语义在 §4-D2 统一收口）。

## 4. 系统化设计

### 4.1 锚点模型：自描述信封

```ts
// domain/event.ts —— 从判别联合升级为开放信封；存量两态 JSON 形状不变（兼容免迁移）
export interface ReplyAnchor {
  /** 注册表登记的平台键（dingtalk/teambition/...）；未登记=入站拒（G4 治理） */
  platform: string;
  /** 平台内回复形态（group/task/thread/chat/...），由适配器声明支持集 */
  kind: string;
  /** 平台原始标识（各适配器自定义 schema 并负责校验），如 {threadId} / {taskId,orgId?} */
  target: Record<string, string>;
  /** 采集时间：时效治理依据（可选） */
  capturedAt?: string;
}
```

存量兼容：钉钉/TB 现有信封形状 `{platform,kind,threadId}`/`{platform,kind,taskId,orgId}` 与信封 target 同构，extractReplyAnchor 读入时做一次归一（把多余键收进 target），无需迁移历史 run.context。

### 4.2 回源适配器契约

```ts
// ports/source-reply-channel.ts（新）
export interface SourceReplyDelivery {
  ok: boolean;
  error?: string;
  /** 平台侧回执句柄（评论 dynamicId / 群消息 id），落审计排障用 */
  receipt?: Record<string, unknown>;
}

export interface SourceReplyAdapter {
  /** 平台键 = ReplyAnchor.platform 匹配值 */
  readonly platform: string;
  /** 支持的 kind 集（deliver 前校验） */
  readonly kinds: readonly string[];
  /** 就绪门：凭证在位 + 插件门开启（复用 isPluginEnabled 模式） */
  available(): boolean;
  deliver(anchor: ReplyAnchor, message: SourceReplyMessage): Promise<SourceReplyDelivery>;
}
```

`SourceReplyMessage = { title?: string; body: string; runId: string }`（markdown 文本与钉钉现状一致；各适配器自行裁剪长度——钉钉 markdown 上限、TB 评论长度限制留在适配器内）。

### 4.3 注册表与装配

```ts
// orchestrator/source-reply-registry.ts（新）
export class SourceReplyRegistry {
  register(adapter: SourceReplyAdapter): void;      // platform 键唯一，重复注册=启动失败
  resolve(anchor: ReplyAnchor): SourceReplyAdapter | undefined;  // platform 匹配 + kind 校验
  async deliver(anchor, message): Promise<SourceReplyDelivery>;  // resolve+available 校验统一报错
}
```

装配（index.ts）：`registry.register(new DingTalkGroupSourceReplyAdapter(dtChannel))`、`registry.register(new TeambitionTaskSourceReplyAdapter(moduleConfigStore, pluginGate))`；event-dispatcher `deps.sourceDeliver` 签名不变（内部改为调 registry），**dispatcher 零改动**。

### 4.4 投递管线语义（executeNotifyRun 内，唯一行为变更点）

| 情形 | 现状 | 新语义 |
|---|---|---|
| 锚点在场 + 适配器就绪 → 投递成功 | log info | **run success** + receipt 落审计（不变 + 增取证） |
| 锚点在场 → 投递失败 | 仅 log，run 仍 success | **run failed**（error=平台错误），与收件人解析失败同级（拍板点 D2） |
| 锚点在场 → 平台未注册/停用 | 抛「不支持的平台锚点」被 catch 成 failed | 同上语义，但日志明确「未注册/未启用」区分 |
| 无锚点（schedule/手动） | warn + 降级 inapp（已强制） | **不变**，且不再产生失败行——与 §4.5 配置校验配合后此情形在保存期即被引导 |
| 锚点 platform 未登记 | 入站无人拦 | **入站即拒**（MessageEventRouter/TB 路由拒信封，fail-closed + 日志） |

### 4.5 配置面收口（接前轮缺陷 A/B）

- 工作流保存校验（PUT/POST + 编辑页）：`channels` 含 `source` 时校验绑定事件类型 ∈ {message, system(带锚点事件)}——schedule/手动绑定 + source 通道 → 400 或强警告（拍板点 D5：硬拦 vs 警告放行）。
- `recipients=correlation` 的校验同批落地（前轮缺陷 A，本设计只挂其实现位：同一保存校验函数）。

### 4.6 级联锚点透传（G2）

`buildExecutionCompletedPayload` 增 `replyAnchor: extractReplyAnchor(sourceContext) ?? undefined`——下游级联工作流（若开 source 通道）可回最原始触发源。下游不用 source 通道时零影响。

## 5. 分期

- **M1（重构等价 + 缺口修复）**：契约 + 注册表 + 两适配器搬迁（钉钉/TB）；source 投递失败回写 run（D2）；级联透传（D4）；保存校验（§4.5）。行为面：钉钉消息处理工作流回源不变，TB bug 工作流的失败行消失（降级语义统一）。
- **M2（唤醒 TB webhook）**：TB 后台配 hook（task.update）→ 端到端验证锚点→评论回写；顺手验证 app 身份评论的展示效果。
- **M3（可选扩展）**：反馈单统一进 source（D3）；飞书适配器 spike（入站 webhook + reply API，验证契约承载新平台只需四步：适配器/注册/锚点声明/事件注册）。

## 6. 拍板点

- **D1 锚点信封 vs 判别联合**：推荐信封（开放闭合是本次目标）；代价是 extractReplyAnchor 加一次归一。
- **D2 source 投递失败是否置 run failed**：推荐**是**（通知轮唯一职责就是投递；失败不可见=监控盲区）。副作用：钉钉群失效类故障会让 notify run 转红——这是期望行为。
- **D3 反馈单是否统一进 source 管线**：推荐**暂不**（专用机制生产验证过且带写边界；统一是架构一致性收益 vs 迁移风险的取舍，非痛点驱动）。
- **D4 级联默认透传**：推荐**开**（下游不开 source 通道零副作用；开了才有回原源能力）。
- **D5 保存校验强度**：推荐 schedule/手动 + source 通道 → **硬拦 400**（hint 文案已被证明拦不住，TB bug 工作流就是活例）；correlation 错配同批硬拦。
