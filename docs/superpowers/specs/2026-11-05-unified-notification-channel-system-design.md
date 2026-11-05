# 统一通知与渠道连接系统设计（合并稿）

- 日期：2026-11-05
- 状态：已拍板（2026-11-05：D6-D10 全落定，D8=累计计数可见方案）；M1 实施轮
- 取代：2026-11-05-source-reply-channel-design.md（回源场景由本设计 §2.6 覆盖，旧稿保留作锚点模型细节参考）
- 需求来源：统一通知管理运行系统需求（对话记录 2026-11-05）+ 三拍板（智能体通知语义 / 适配器能力声明 / 回源合并）

## 0. 一句话

把「渠道」升格为平台一等资产：**ChannelAdapter 统一契约**（出站推送 + 回原 + 入站 webhook/pull/stream + 配置 schema + 连通性测试）驱动「渠道连接」分区（连接器 tab2），通知内核收敛为**系统/工作流/智能体三类**订阅矩阵，投递取「发送方指定 ∩ 用户订阅 ∩ 地址在位」交集，新平台接入 = 实现一个适配器。

## 1. 现状锚点（读码结论，master 1c0de3dd）

| 部件 | 位置 | 现状 |
|---|---|---|
| 通知内核 | `orchestrator/notification-service.ts` | 全系统会话外通知唯一发出点：目录校验 fail-closed → 脱敏 → 收件人展开 → 路由合成（站内恒发 ∪ 用户偏好 ∩ intent.channels）→ 未读频控 → 站内落库 → 站外异步分发（重试 2s/8s） |
| 事件目录 | `domain/notification.ts:57` | **18 事件 × 7 组**（task/loop/system/account/feedback/deploy/share），核实全部活跃（动态 emit 含 task.completed/failed、loop.run_*、deploy.*） |
| 通道枚举 | `domain/notification.ts:32` | `inapp|dingtalk|webhook|email` 硬编码，贯穿 prefs schema/DB/前端 |
| 站外适配器 | `adapters/notif-{dingtalk,webhook,email}.ts` | `NotificationChannelAdapter {id,available(),send()}` 三实现；钉钉 oToMessages+地址簿（unionId→staffId 换算缓存）；地址簿 notification_addresses 现空表 |
| 回源（source） | `index.ts:734 sourceDeliver` | 硬编码 if/else（钉钉群 send / TB createTaskComment）；锚点判别联合两态（dingtalk group / teambition task）；无锚点降级 inapp 已内建；**回源失败仅 log 不回写 run** |
| 入站 | `dingtalk-channel.ts:51` + `domain/teambition.ts:68` + `message-event-router.ts` | 统一信封+replyAnchor+10min 去重+filter 收窄+无订阅回落对话；钉钉群@生产跑通；TB webhook 代码就绪休眠（端点 web-channel.ts:1429） |
| 订阅/地址簿 | `NotificationPage.tsx` 三分区 | 订阅=组×通道矩阵（opt-in）；推送=地址簿（dingtalk 验证码绑定/webhook/email）；账号组强制站内信（isMandatoryGroup） |
| 智能体任务通知 | `orchestrator.ts:1356` | **task.completed/failed 已具备拍板语义骨架**：交互式会话轮末发站内信（`!silent && !quietResult && !unattended`——工作流派发/内部轮天然不发），link=`/?conv=` 直达会话，dedupeKey 防重 |
| 连接器页 | `ConnectorsPage.tsx` | 单列表（MCP/HTTP 两类型）+ 分享 + 凭证；无渠道概念 |

## 2. 目标架构

### 2.1 渠道适配器契约（统一实现层）

```ts
// ports/channel-adapter.ts（新，收编 notif-* 与 sourceDeliver）
export interface ChannelAdapter {
  /** 渠道键：dingtalk / teambition / email / webhook / lark / ... */
  readonly id: string;
  readonly displayName: string;

  /** 能力声明（UI 按此渲染：无出站不进订阅矩阵选项；无入站不显示监听区；未适配能力显示「暂未适配」） */
  readonly capabilities: {
    outboundPush: boolean;      // 订阅矩阵可选（地址簿投递）
    replyToSource: boolean;     // 回原投递（锚点消费）
    inbound: "webhook" | "pull" | "stream" | null;
  };

  /** 连接配置 schema（appKey/appSecret/baseUrl/webhook URL...，zod；驱动渠道连接配置表单） */
  configSchema: z.ZodType<Record<string, string>>;

  /** 连通性测试（渠道连接卡片「测试」按钮） */
  testConnection(config: Record<string, string>): Promise<{ ok: boolean; error?: string; detail?: string }>;

  /** 出站推送（订阅投递；地址由地址簿提供） */
  send?(config: Record<string, string>, address: string, message: OutboundMessage): Promise<Delivery>;

  /** 回原投递（原 SourceReplyAdapter 收编；锚点=§2.6 自描述信封） */
  replyToSource?(config: Record<string, string>, anchor: ReplyAnchor, message: SourceReplyMessage): Promise<Delivery>;

  /** 入站（三选一，按 capabilities.inbound 声明） */
  inboundWebhook?{
    verify(req): boolean;                       // 签名/token 校验
    normalize(req): Promise<PlatformEnvelope>;  // 归一信封（含 replyAnchor）
  };
  inboundPull?{ start(config, onMessage): void; stop(): void; status(): InboundStatus };
  inboundStream?{ start(config, onMessage): void; stop(): void; status(): InboundStatus };
}
```

**拍板 #2 落地**：能力缺失即「暂未适配」——订阅矩阵/工作流通知渠道选择列表只列 `capabilities.outboundPush=true` 且有适配实现的渠道；渠道连接卡片对未适配能力显示「暂未适配」徽标。

### 2.2 渠道连接（新资产，连接器 tab2）

- 存储：新表 `channel_connections`（platform, name, config 加密 JSON（SecretCipher）, enabled, lastTestResult, inboundStatus 快照, createdAt/updatedAt）。
- **配置真源（拍板点 D6，推荐混合）**：钉钉/SMTP 引用授权页 module_configs 既有配置（授权页仍是三方登录/SMTP 职责真源，渠道连接展示「引用自授权页」+ 测试入口）；新平台（lark 等）在渠道连接自持配置。避免双写漂移。
- 服务：`ChannelConnectionService`（CRUD + testConnection + 入站监听生命周期 start/stop/status + 启停开关）。
- 地址簿：`notification_addresses` 归属渠道连接（数据不动，API/UI 迁移到渠道连接分区）。

### 2.3 通知内核收敛（三类）

```ts
export type NotificationEventGroup = "system" | "workflow" | "agent";
```

归并映射（18 事件全活跃，无删除只归组）：

| 新类 | 事件 | 存量组映射 |
|---|---|---|
| **系统通知**（默认开启不可关） | eviction.notice、user.role_changed、credential.missing、system.announcement、deploy.detected/succeeded/failed、loop.queue_overflow、feedback.replied | system+account+feedback+deploy+loop.queue_overflow |
| **工作流通知** | workflow.run_succeeded/run_failed（原 loop.run_* 改名）、workflow.result_notified（与前者受众语义统一：owner=运行结果，recipients=notifyPolicy 投递） | loop |
| **智能体通知** | **agent.replied / agent.run_failed（新，见 §2.4，收编 task.completed/task.failed）**、approval.requested/decided、agent.skill_issue_reported/skill_suggestion | task+share |

### 2.4 智能体回复通知（拍板 #1 落地）

**语义**：用户与智能体对话，**每次回复后通知**；查看通知或查看对话即已读；**工作流调用的轮不发**。

- **事件**：`agent.replied`（轮成功）/ `agent.run_failed`（轮失败），emit 点沿用 `orchestrator.ts:1356` 现有位置——其守卫条件 `!silent && !quietResult && !unattended` **恰好就是拍板语义**（工作流派发轮 unattended=true 不发；notify/内部轮 silent/quietResult 不发），收编后仅改事件键与文案（标题带智能体名）。
- **已读联动（新）**：notifications 表增 `conversationId` 索引列（仅 agent 组事件写）；新增 `POST /api/conversations/:id/seen`——打开会话（bootstrap）时调用，把该会话未读 agent 通知批量标已读。点通知（link=`/?conv=`）走现有已读机制。
- **渠道交集**：Agent schema 增 `notifyPolicy: { enabled, channels }`（对称 workflow.notifyPolicy.channels；缺省 `["inapp"]`，拍板点 D9）。
- **活跃会话抑制（拍板点 D7，推荐抑制）**：用户正在查看该会话（SSE 在线）时跳过通知——在线即免打扰，避免通知列表被正在看的对话刷屏。
- **频率**：一轮一条（轮末 result 事件天然一次），dedupeKey=`agent:{conversationId}:{messageId}`。

### 2.5 交集投递（需求核心语义）

```
实际投递渠道 = 发送方渠道（workflow.notifyPolicy.channels / agent.notifyPolicy.channels）
             ∩ 用户订阅（通知中心：通知类型 × 渠道 enabled）
             ∩ 地址在位（outboundPush 渠道须地址簿已配置；email=注册身份免绑定）
站内（inapp）恒发：系统/工作流/智能体三类的 inapp 订阅锁定为开、UI 不可关（后端本就强制站内发，补 UI 锁定）
被裁剪提醒：发送方指定的渠道因「用户未订阅」或「未配置地址」被裁剪 → 发一条系统通知提醒该用户
           （节流：同 用户×渠道×通知类型 24h 去重，拍板点 D8）
```

### 2.6 入站管线 + 回原合并（拍板 #3）

- **入站**：`MessageEventRouter` 泛化为按注册表路由——适配器 `inboundWebhook.normalize` 产统一信封（含 replyAnchor）→ 路由 → 订阅匹配 → workflow fire；pull/stream 型由 ChannelConnectionService 管理生命周期，onMessage 汇入同一路由。渠道连接卡片显示监听状态 + 「测试」按钮（webhook=回放样例信封、pull=立即拉取一轮、stream=连接状态探测）。
- **回原**：`replyToSource` 收编原 sourceDeliver；锚点沿用前稿自描述信封 `{platform, kind, target, capturedAt}`；投递语义沿用前稿拍板（失败回写 run failed、无锚点降级 inapp、级联透传）。
- **入站回落语义保牌**：钉钉无订阅回落对话（现有核心体验）不因渠道化改变。

## 3. 数据与迁移

1. 新表 `channel_connections`（§2.2）；`notification_addresses` 数据不动、归属迁移。
2. `notification_prefs` 组归并迁移（幂等）：task→agent、loop→workflow、system/account/feedback/deploy→system、share→agent；矩阵从 7 行缩为 3 行/渠道。
3. `notifications` 表加 `conversationId` 列（agent 组事件写，索引）。
4. 事件目录改名连锁：`loop.run_*` → `workflow.run_*`，`task.completed/failed` → `agent.replied/agent.run_failed`——调用点同步（orchestrator.ts:1359、event-dispatcher.ts:782 ≈ 2 处动态键 + 其余事件键不变仅归组）。

## 4. UI 变更

1. **ConnectorsPage 双纵向 tab**（对话模块同款交互）：tab1「能力连接」（现状不动）；tab2「渠道连接」（渠道卡片列表：配置状态/启停开关/测试按钮/监听状态+测试/地址簿入口；未适配能力显示「暂未适配」）。
2. **NotificationPage**：订阅分区改 **3 类 × 渠道**矩阵（inapp 行锁定开启）；「推送」分区迁入渠道连接；通知列表不变（agent.replied 通知点开直达会话并标已读）。
3. **WorkflowEditorPage**：notifyPolicy.channels 选项列表 = 注册表中 `outboundPush=true` 的渠道（未适配不展示，拍板 #2）。
4. **AgentEditorPage**：新增「通知」配置区（启用开关 + 渠道多选，缺省 inapp）。
5. 授权页钉钉/SMTP 区块保留（登录/SMTP 真源），渠道连接展示引用关系。

## 5. 分期

- **M1 通知收敛 + 交集 + 智能体回复通知**（纯站内可先行）：三类归组/目录改名连锁、订阅矩阵迁移、交集+被裁剪提醒（节流）、inapp 锁定、agent.replied 已读联动。
- **M2 渠道连接分区 + 出站注册表**：tab 重排、渠道卡片（配置/测试/启停）、钉钉/webhook/email 三适配器搬迁入契约、地址簿迁入、订阅/编辑器渠道列表接注册表。
- **M3 入站渠道化 + 回原收编**：webhook 型入站入注册表（钉钉回调、TB 唤醒端到端）、replyToSource 收编（锚点信封+失败回写 run+级联透传）、渠道连接展示监听状态+测试。
- **M4 pull/stream + 样板**：钉钉 Stream（免公网回调，对本机 DDNS+自签部署关键）、邮件 IMAP 拉取、飞书适配器样板（验证新平台接入四步：适配器/注册/锚点声明/事件订阅）。

## 6. 拍板点

- **D6 配置真源**：推荐混合——钉钉/SMTP 引用授权页 module_configs（防双写漂移），新平台自持 channel_connections。
- **D7 活跃会话抑制**：推荐抑制（用户正在查看的会话不发通知，在线即免打扰）。
- **D8 被裁剪提醒（已拍板，2026-11-05）**：**累计计数方案**——不做静默去重：每次裁剪累加计数（notification_trim_stats），提醒通知展示「已累计 N 条因未订阅/未配置地址被转为系统通知」；新提醒通知按 24h 窗口合并（计数持续累加，用户始终可见次数）。
- **D9 agent.notifyPolicy 缺省**：推荐 `["inapp"]`（站内保底，站外由用户订阅 opt-in）。
- **D10 workflow.run_* 与 result_notified 受众统一**：推荐保留双事件（owner 运行结果 vs recipients 投递语义不同）但归同一通知类。

## 7. 影响面与回归样板

1. 钉钉无订阅回落对话（入站核心体验，M3 回归样板）。
2. 反馈闭环通知（feedback.replied 归系统组，受众文案不变——键不变仅归组，零调用点改动）。
3. 审批卡 mandatoryInapp 强制语义（workflow 挂起保护）保留。
4. 存量订阅迁移幂等 + 可回滚（迁移失败用户订阅静默回缺省是主要风险）。
5. notify 调用点连锁（约 12 处中仅 2 处事件键改名，其余零改动）。
