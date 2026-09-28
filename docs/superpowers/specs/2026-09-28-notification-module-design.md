# 通知模块架构设计（Notification Module Design）

- 日期：2026-09-28
- 状态：待拍板（未动码）
- 上游输入：2026-09-28 通知能力盘点（已实现/半实现/未实现清单，见会话记录）
- 核心诉求：**收紧全系统的通知能力，统一在通知模块进行管理和配置**；补齐站外推送能力

---

## 1. 现状盘点（设计输入）

### 1.1 通知能力散点地图

| 散点 | 现状 | 问题 |
|---|---|---|
| 任务完成/失败通知 | `event-bridge.ts` 仅对会话通道 `send()`（SSE/钉钉回复） | 只对"在场会话"生效；无人值守任务无人看见 |
| 并发淘汰 `eviction_notice` | `web-channel.ts:919` ad-hoc SSE 广播 | 发出点散落，无落库、无站外 |
| 角色变更 `user_role_change` | `web-channel.ts:2871` SSE 即时推 | 同上 |
| 凭证缺失卡片 | 会话内 SSE 卡片 | 离开该会话即不可见 |
| loop/trigger 运行结果 | `loop-runner.ts` 仅写 `loop_runs.lastError` | 跑挂了没有任何主动告知，无人值守断链 |
| 反馈回复 | FeedbackPage 站内时间线 | 提交者无未读提醒 |
| 钉钉出站 | 仅 `oToMessages` 回复既有会话（`dingtalk-channel.ts:58` recipients 来自入站消息，**内存映射**） | 无法主动触达任意用户；重启即丢 |
| 钉钉 AI 卡片 API | `dingtalk-api.ts:248 createAndDeliverCard` 已实现 | 全仓零调用方（半成品） |
| 邮箱 | 仅登录方式，注册验证链接靠管理员人工转交 | 无 SMTP 发信 |
| 系统事件 | system_events 落库 → 审计页 | 观测面而非触达面 |
| 回调 API | `GET /api/callbacks/:token/...` 纯轮询 | 无完成后出站回调 |

### 1.2 可复用的既有地基

- `user_identities` 表：钉钉登录用户的 staffId 已持久化（`UserIdentity.provider="dingtalk", externalId`）——站外推送地址簿的地基已存在。
- `net-target.ts`：`validateTriggerHttpUrlDeep`（DNS 解析后复判内网）——webhook 出站 SSRF 守卫直接复用。
- `secret-cipher` / connector store：通道凭证加密存储范式。
- `module_config`（ModuleKey 机制）：三方配置纯 DB 单一真源——通知通道凭证照此扩展。
- `memory-rate-limiter`、`redactSecrets`（audit.ts）：频控与脱敏直接复用。
- SSE 广播面（broadcastToConversation）：保留为"实时面"，通知模块作为"触达面"叠加其上。

---

## 2. 目标与非目标

### 2.1 目标

1. **唯一发出点**：全系统一切"会话外通知"收敛到 NotificationService 单一入口；新增通知场景禁止再造 ad-hoc 广播。
2. **用户收件人模型**：通知目标从 conversationId/threadId 升级为平台用户（user-bound），配持久化地址簿。
3. **站外推送**：钉钉主动推送、出站 Webhook 先行；SMTP、Web Push 分期跟上。
4. **统一管理与配置**：事件路由规则、通道开关、用户订阅偏好、地址簿全部在通知模块配置面管理。
5. **可观测**：每条通知的投递结果可查（deliveries 日志）。

### 2.2 非目标（明确排除，防边界蔓延）

- **不收编会话消息流**（text_delta / thinking_delta / tool_use / tool_result / activity）：这是聊天传输面（`Channel` port），不是通知。塞进通知模块会把消息管道与通知管道耦合。
- **不收编交互回流**：审批决议（钉钉回复「通过」/ Web 卡片按钮）、AskUserQuestion 问询——是输入不是通知。
- **不动审计本体**：audit_events / system_events 落库语义不变；通知模块只是可选的下游订阅方。
- M1-M2 **不向 agent 暴露发通知工具**（见 §7 安全红线第 1 条）。

---

## 3. 总体架构

```
┌─ 事件源层（emitters，只声明语义意图，不关心通道）────────────────┐
│  event-bridge（task.completed/failed）                            │
│  loop-runner（loop.run_succeeded/run_failed）                     │
│  web-channel（eviction.notice / user.role_changed /               │
│               credential.missing）                                │
│  feedback handler（feedback.replied）                             │
│  admin API（system.announcement，M2）                             │
└──────────────────────┬───────────────────────────────────────────┘
                       │ notify(NotificationIntent)
                       ▼
┌─ 通知内核 NotificationService ──────────────────────────────────┐
│  ① 事件目录校验（受控枚举，fail-closed：未登记事件拒发）          │
│  ② 收件人解析（role/all → 用户集合；逐用户处理）                  │
│  ③ 路由决策（系统默认规则 ∪ 用户订阅偏好）                        │
│  ④ 去重/频控（dedupeKey 幂等 + 速率限制）                         │
│  ⑤ 落站内信（notifications 表，恒写）                             │
│  ⑥ 通道分发（异步，逐适配器投递，写 deliveries）                   │
│  ⑦ 脱敏（redactSecrets 过 title/body）                            │
└──────────────────────┬───────────────────────────────────────────┘
                       ▼
┌─ 通道适配层 NotificationChannelAdapter（可插拔）─────────────────┐
│  inapp    站内信（内核直写，恒开，无适配器 I/O）                   │
│  dingtalk 机器人主动推送（oToMessages，地址簿持久化）              │
│  webhook  出站 POST（SSRF 守卫 + 签名头）                         │
│  email    SMTP（M3）                                              │
│  webpush  VAPID 浏览器推送（M4）                                  │
└──────────────────────────────────────────────────────────────────┘
```

**SSE 与通知的关系**：通知模块落站内信后，在线用户通过顶栏铃铛轮询/SSE 感知；现有 `eviction_notice` 等会话内实时弹窗**保留**（实时面），通知模块叠加"离场也能看见"的触达面。二者不互斥。

---

## 4. 核心抽象

### 4.1 NotificationIntent（通知意图）

```ts
type NotificationEvent =
  | "task.completed" | "task.failed"
  | "loop.run_succeeded" | "loop.run_failed"
  | "eviction.notice" | "user.role_changed" | "credential.missing"
  | "feedback.replied"
  | "approval.requested"        // M2
  | "system.announcement";      // M2

interface NotificationIntent {
  event: NotificationEvent;          // 受控枚举，fail-closed
  recipients: RecipientRef[];
  severity: "info" | "warn" | "critical";
  title: string;
  body: string;                      // 发出方渲染摘要；通知模块不做模板引擎（M1）
  dedupeKey?: string;                // 如 "loop:{loopId}:failed:{runId}"
  link?: string;                     // 站内跳转路径（/loops/:id 等）
  data?: Record<string, string>;     // 结构化载荷（webhook JSON 体用）
}

type RecipientRef =
  | { kind: "user"; userId: string }
  | { kind: "role"; role: "admin" }  // M2
  | { kind: "all" };                 // M2，公告专用
```

设计约束：
- **事件枚举 fail-closed**：未登记的 event 在 service 入口直接拒绝。这是"收紧"的机制保障——防止各处随手字符串扩散，新增事件必须先登记目录（含默认路由、severity、可否用户关闭）。
- **意图与通道解耦**：发出方不知道也不该知道最终走钉钉还是 webhook。
- **模板 M1 硬编码**：title/body 由发出方拼好中文文案；模板自定义（模板表+变量插值）放 M3，避免一期背模板引擎。

### 4.2 收件人与地址簿（notification_addresses）

通知目标是**平台用户**。每用户每通道至多一条投递地址：

| 通道 | 地址来源 | 说明 |
|---|---|---|
| inapp | 无需地址 | 恒可用 |
| dingtalk | 优先取 `user_identities(provider="dingtalk").externalId`；未绑钉钉登录的用户可在通知模块手动填报 staffId | 手填地址须**验证**（向该 staffId 发一条验证消息+用户确认码）后才生效，防填他人 staffId 骚扰/信息泄露 |
| webhook | 用户配置的 URL + 可选自定义 header（header 值加密存储） | 出站属主=该用户 |
| email | `users.email` | M3；需已验证邮箱 |

这一层顺带根治钉钉 `recipients` 内存映射问题：地址簿持久化后，主动推送不再依赖"用户先发过消息"。

### 4.3 通道适配器接口

```ts
interface NotificationChannelAdapter {
  readonly id: "dingtalk" | "webhook" | "email" | "webpush";
  /** 通道配置是否齐备；缺配置=该通道本轮 skipped（不报错不重试） */
  available(): boolean;
  send(addr: ChannelAddress, n: OutboundNotification): Promise<DeliveryResult>;
  /** 地址校验（dingtalk 手填验证 / webhook 探活）；无则视为免校验 */
  verifyAddress?(addr: string): Promise<{ ok: boolean; detail?: string }>;
}
```

- 适配器**无状态**，配置由 service 注入（读 module_config + 内核缓存）。
- 单通道失败只影响自己的 delivery 记录，不阻塞其他通道、不阻塞事件源（fire-and-forget + 重试上限 2 次、指数退避；webhook 重试须幂等头 `X-Donger-Notification-Id`）。

### 4.4 路由决策（两级规则）

1. **系统默认路由**（admin 配置，事件目录内置默认值）：`event → channels[]`。默认全部事件仅 inapp；loop.run_failed 默认 inapp（站外需用户显式订阅）。
2. **用户订阅偏好**（用户自己配置）：`事件组 × 通道` 的开/关矩阵。站外通道默认关（opt-in）；站内默认开。
   - **不可关闭清单**（事件目录里标记 `mandatoryInapp: true`）：`user.role_changed`——安全相关通知不允许用户自关站内信。

规则合成语义：`有效通道 = 系统默认 ∪ 用户开启的站外通道 − 用户关闭的站内通道（mandatory 除外）`。M1 规则引擎就是这张静态合成，不做复杂表达式。

---

## 5. 数据模型（5 张新表）

> 建表前先 `grep DROP TABLE` 核对撞名（历史坑：credential-sets 的 DROP 曾静默删掉撞名新表）。`notification_` 前缀无存量撞名。

```sql
-- 站内信（恒写，通知的事实主表）
CREATE TABLE notifications (
  id TEXT PRIMARY KEY, userId TEXT NOT NULL,
  event TEXT NOT NULL, severity TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL,
  link TEXT, dedupeKey TEXT,
  readAt TEXT, createdAt TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_notif_dedupe ON notifications(dedupeKey) WHERE dedupeKey IS NOT NULL;
CREATE INDEX idx_notif_user ON notifications(userId, createdAt DESC);

-- 地址簿（每用户每通道一条）
CREATE TABLE notification_addresses (
  userId TEXT NOT NULL, channel TEXT NOT NULL,
  address TEXT NOT NULL,          -- webhook 场景存 JSON(url+加密headers)
  extra TEXT,                     -- 加密字段（如 webhook headers）
  verifiedAt TEXT, createdAt TEXT NOT NULL,
  PRIMARY KEY (userId, channel)
);

-- 路由规则（ownerId NULL = 系统默认，admin 维护）
CREATE TABLE notification_rules (
  id TEXT PRIMARY KEY, ownerId TEXT,
  eventPattern TEXT NOT NULL,     -- 精确事件或事件组（如 "loop.*"）
  channels TEXT NOT NULL,         -- JSON array
  enabled INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);

-- 用户订阅偏好
CREATE TABLE notification_prefs (
  userId TEXT NOT NULL, eventGroup TEXT NOT NULL, channel TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (userId, eventGroup, channel)
);

-- 投递日志（排障与可观测）
CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY, notificationId TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,           -- ok | failed | skipped
  error TEXT, attempts INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL
);
CREATE INDEX idx_deliv_notif ON notification_deliveries(notificationId);
```

通道凭证（SMTP 密码、webhook 默认签名密钥等）不放上面任何表，统一进 `module_config` 新键 `notification`（值经 secret-cipher 加密，与 dingtalk/github/email/proxy 同机制）。

---

## 6. 存量散点收编映射（改造清单）

| 现状发出点 | 改造 |
|---|---|
| `event-bridge.ts` result success/error 分支 | 追加 `notify(task.completed/failed)`。仅对**非 silent**轮生效；dedupeKey=`task:{taskId}:{subtype}` |
| `loop-runner.ts` success/failed 分支 | `notify(loop.run_succeeded/run_failed)`，recipients=loop.ownerId，dedupeKey 含 runId |
| `web-channel.ts` eviction_notice 广播处 | 广播保留 + `notify(eviction.notice)`（收件人=被淘汰任务属主） |
| `web-channel.ts` user_role_change 广播处 | 广播保留 + `notify(user.role_changed)`（mandatory 站内信） |
| 凭证缺失问询处 | 卡片保留 + `notify(credential.missing)`（仅 pause 降级路径发，避免会话内交互与站内信双抖动——实现时定） |
| feedback 回复 handler | `notify(feedback.replied)`（收件人=反馈提交者） |
| `dingtalk-channel.ts` recipients 内存映射 | M2 改读地址簿（保留会话内回复路径不动；主动推送走新通道适配器，**不复用** dingtalk-channel） |
| 注册邮箱验证（管理员转交链接） | M3 随 SMTP 收编为系统发信（决策点 ⑦） |

**冻结面（收紧的工程约定）**：`Channel` port **不再新增任何通知类 `push*` 方法**；新通知场景一律走 NotificationService。event-bridge/web-channel 里现存的 push 系列是聊天传输面，维持不动。

---

## 7. 安全红线（本项目惯例，逐条落地）

1. **通知模块是平台能力，不是 agent 工具**。agent 可发通知 = 把会话内容推到外部端点的数据外传通道。M1-M2 不注册任何 agent 侧工具；远期若开放，须过审批门+事件白名单，另立决策。
2. **webhook 出站 SSRF 守卫**：URL 保存时与每次发送时都过 `validateTriggerHttpUrlDeep`（net-target，DNS 解析后复判内网/环回/元数据地址）；`allowPrivateNet` 开关与 trigger 共用同一 env；**跟随重定向后对最终地址复判**；响应体不回显给用户（防内网数据回读，同 trigger 的教训）。
3. **内容脱敏**：title/body 入库与出站前过 `redactSecrets`；通知载荷只允许发出方显式放进 `data` 的字段，禁止透传任意对象。
4. **属主铁律**：notifications/addresses/prefs/deliveries 全部 userId 过滤；admin 才可跨用户查投递日志。所有新路由登记 `web-route-guards` 守卫表（漏登记=404）+ API 参数段收窄 `[\w.-]+`（query 串吞噬历史坑）。
5. **地址验证**：钉钉 staffId 手填须验证闭环（系统发验证消息→用户回填确认码）；webhook 首次保存做一次探活但**不回显响应内容**。
6. **频控**：出站 webhook 每用户默认 ≤10 次/分钟；站内信单用户堆积上限（如未读 >500 时拒绝新通知并告警 admin）；`system.announcement` 群发走分批队列。
7. **凭证不落通知**：任何通知 payload 不含凭证值/JWT/密文；webhook 自定义 header 值加密存储、任何 API 不回显明文。

---

## 8. 配置面（通知模块页面）

按"同意在通知模块进行管理和配置"：

- **管理端（admin）**：通道实例开关与凭据（钉钉机器人=复用授权页现有三方配置；SMTP；webhook 全局参数）+ 系统默认路由表 + 全局频控参数。归属建议放**授权页新增"通知"区**（授权页刚完成能力面重排，通道/凭证类配置收敛于此符合现行信息架构），不做一级导航新页。
- **用户端**：
  - **站内信中心**：顶栏铃铛 + 未读数 + 浮层列表（全部已读/单条已读/跳转 link）。铃铛未读数走轻量轮询（30s）或复用 SSE 常连，M1 用轮询最简。
  - **订阅偏好**：事件组 × 通道矩阵（站内/钉钉/webhook 三列开关）。
  - **地址簿**：钉钉 staffId 绑定与验证、webhook 端点管理（增删+探活+投递测试按钮）。
  - 归属建议放铃铛浮层"设置"入口 + 个人页分区，同样不新增一级导航。

---

## 9. 事件目录（M1 受控清单）

| 事件 | severity | 默认路由 | mandatory 站内 | 去重键 |
|---|---|---|---|---|
| task.completed | info | inapp | 否 | task:{id}:completed |
| task.failed | warn | inapp | 否 | task:{id}:failed |
| loop.run_succeeded | info | inapp | 否 | loop:{id}:ok:{runId} |
| loop.run_failed | critical | inapp | 否 | loop:{id}:fail:{runId} |
| eviction.notice | warn | inapp | 是 | eviction:{taskId} |
| user.role_changed | critical | inapp | **是** | role:{userId}:{ts}（不去重） |
| credential.missing | warn | inapp | 否 | cred:{taskId} |
| feedback.replied | info | inapp | 否 | fb:{id}:{replyId} |

连续失败合并策略：同一 loop 连续 ≥3 次失败后进入退避（30 分钟窗口内只发一条），恢复成功必发一条——防风暴。

---

## 10. 分期计划

### M1 内核 + 站内信中心（纯站内，无外部依赖）
- NotificationService 端口与实现、事件目录、5 张表迁移
- 站内信落库 + 铃铛 UI（未读数/列表/已读/跳转）
- 收编 6 个存量散点（§6 前六行）
- 订阅偏好 API + 偏好开关矩阵（M1 只有 inapp 一列，但表结构与合成逻辑一次到位）

### M2 站外推送一期（无人值守刚需闭环）
- dingtalk 适配器：地址簿持久化 + 手填验证闭环 + 主动推送（复用 `sendSingleMessage`；AI 卡片 API 视需要启用——`createAndDeliverCard` 已有实现，正好消化半成品）
- webhook 适配器：SSRF 守卫 + 签名头 + 重定向复判 + 频控
- 管理端通道配置页（授权页"通知"区）+ 投递日志查询
- `system.announcement` admin 群发 + `approval.requested` 触达收编

### M3 邮件通道
- SMTP 适配器 + 已验证邮箱地址簿
- 注册验证邮件系统发信（替换管理员转交）
- 模板自定义（模板表 + 变量白名单插值，渲染后仍过 redactSecrets）

### M4 Web Push / 浏览器通知
- VAPID 订阅管理 + Service Worker push handler（现有 PWA 基建上扩展）
- 前台标签页 Notification API 兜底

每期独立可上线；M1 完成后系统即获得"唯一发出点+站内信中心"，站外能力是通道适配器的增量插入，不动内核。

---

## 11. 决策点（已拍板，2026-09-28）

| # | 决策 | 拍板结果 |
|---|---|---|
| ① | 会话传输面不收编的边界（聊天流式/审批决议/问询留在 Channel port） | **同意** |
| ② | 交互式会话的任务完成是否也发站内信 | **发**（全部任务完成/失败均发站内信） |
| ③ | agent 工具化发通知 | **暂不开放** |
| ④ | 站外通道优先级：钉钉主动推送 + webhook 先行（M2），SMTP M3 | **同意** |
| ⑤ | 用户不可关闭的通知清单 | **同意**（仅 `user.role_changed` 强制站内信） |
| ⑥ | 配置入口 | **改为：新增「通知」一级导航页**（站内信中心+订阅偏好+地址簿集中在该页；管理端通道配置 M2 入授权页不变） |
| ⑦ | 邮箱验证流程 M3 随 SMTP 改系统发信 | **同意**（保留人工通道为 SMTP 故障兜底） |
| ⑧ | 钉钉手填 staffId 的验证强度 | **验证码闭环**（发验证消息+回填确认码） |

## 12. 验收样板（场景仅作验收，不固化设计）

1. loop 定时任务失败 → 属主铃铛未读+1，点开可见 lastError 摘要，跳转 LoopDetail。
2. 用户绑定钉钉 staffId → 订阅 loop.run_failed → 钉钉收到主动推送；重启服务后推送仍通（地址簿持久化验证）。
3. webhook 订阅 → 用户在地址簿填 `http://192.168.1.1/hook` → 保存被 SSRF 守卫拦截。
4. 管理员降级某用户 → 该用户（即使离线）下次登录看到不可关闭的站内信。
5. 反馈被回复 → 提交者铃铛未读+1。
6. 全部通知在投递日志可查（ok/failed/skipped + error）。
