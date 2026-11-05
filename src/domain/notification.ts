import { z } from "zod";

/**
 * 通知域模型（spec 2026-09-28-notification-module-design）。
 *
 * 事件目录是受控枚举：NotificationService 对未登记事件 fail-closed 拒发。
 * 新增通知场景必须先在此登记（含分组/severity/是否强制站内信），禁止各处随手字符串扩散。
 */

export type NotificationEvent =
  | "agent.replied"
  | "agent.run_failed"
  | "workflow.run_succeeded"
  | "workflow.run_failed"
  | "loop.queue_overflow"
  | "eviction.notice"
  | "user.role_changed"
  | "credential.missing"
  | "feedback.replied"
  | "approval.requested"
  | "approval.decided"
  | "system.announcement"
  | "deploy.detected"
  | "deploy.succeeded"
  | "deploy.failed"
  | "workflow.result_notified"
  | "notify.channel_trimmed"
  | "agent.skill_issue_reported"
  | "agent.skill_suggestion";

/** 订阅偏好按事件组粒度（用户不感知单事件开关）；组×通道成矩阵 */
/**
 * 通知三分类（2026-11-05 统一通知设计拍板）：系统/工作流/智能体。
 * 用户订阅矩阵按此三行×渠道配置；站内信全组锁定开启（isMandatoryGroup 恒真）。
 */
export type NotificationEventGroup = "system" | "workflow" | "agent";

export type NotificationSeverity = "info" | "warn" | "critical";

/** 投递通道：站内信恒开；站外通道用户显式订阅（opt-in，spec §4.4） */
export type NotificationChannelId = "inapp" | "dingtalk" | "webhook" | "email";

export type OutboundChannelId = Exclude<NotificationChannelId, "inapp">;

export const OUTBOUND_CHANNELS: OutboundChannelId[] = ["dingtalk", "webhook", "email"];

export interface NotificationEventSpec {
  group: NotificationEventGroup;
  severity: NotificationSeverity;
  /** 强制站内信：安全相关通知，用户偏好不可关闭（决策⑤：仅 user.role_changed） */
  mandatoryInapp: boolean;
  label: string;
}

export const NOTIFICATION_EVENT_CATALOG: Record<NotificationEvent, NotificationEventSpec> = {
  // 智能体通知：交互式会话每轮回复后通知（工作流派发/内部轮不发，守卫见 orchestrator emit 点）
  "agent.replied": { group: "agent", severity: "info", mandatoryInapp: false, label: "智能体已回复" },
  "agent.run_failed": {
    group: "agent",
    severity: "warn",
    mandatoryInapp: false,
    label: "智能体回复失败",
  },
  "workflow.run_succeeded": {
    group: "workflow",
    severity: "info",
    mandatoryInapp: false,
    label: "工作流运行成功",
  },
  "workflow.run_failed": {
    group: "workflow",
    severity: "critical",
    mandatoryInapp: false,
    label: "工作流运行失败",
  },
  "loop.queue_overflow": {
    group: "system",
    severity: "warn",
    mandatoryInapp: false,
    label: "触发队列溢出丢事件",
  },
  "eviction.notice": {
    group: "system",
    severity: "warn",
    mandatoryInapp: true,
    label: "并发任务被自动结束",
  },
  "user.role_changed": {
    group: "system",
    severity: "critical",
    mandatoryInapp: true,
    label: "账号角色变更",
  },
  "credential.missing": {
    group: "system",
    severity: "warn",
    mandatoryInapp: false,
    label: "任务缺凭证暂停",
  },
  "feedback.replied": {
    group: "system",
    severity: "info",
    mandatoryInapp: false,
    label: "反馈有新回复",
  },
  "approval.requested": {
    group: "agent",
    severity: "warn",
    // 强制站内信：审批不决议 = workflow 永久挂起（2026-10-10 生产实证），不允许被组偏好静音
    mandatoryInapp: true,
    label: "等待审批",
  },
  "approval.decided": {
    group: "agent",
    severity: "info",
    mandatoryInapp: false,
    label: "审批已决议",
  },
  "system.announcement": {
    group: "system",
    severity: "info",
    mandatoryInapp: false,
    label: "系统公告",
  },
  "deploy.detected": {
    group: "system",
    severity: "warn",
    mandatoryInapp: false,
    label: "发现新提交待部署",
  },
  "deploy.succeeded": {
    group: "system",
    severity: "info",
    mandatoryInapp: false,
    label: "部署成功",
  },
  "deploy.failed": {
    group: "system",
    severity: "critical",
    mandatoryInapp: false,
    label: "部署失败",
  },
  "workflow.result_notified": {
    group: "workflow",
    severity: "info",
    mandatoryInapp: false,
    label: "工作流结果通知",
  },
  // 被裁剪提醒（拍板 D8 累计计数）：发送方指定渠道被用户订阅/地址裁剪时转入系统通知并提示次数
  "notify.channel_trimmed": {
    group: "system",
    severity: "warn",
    mandatoryInapp: true,
    label: "渠道投递被裁剪提醒",
  },
  "agent.skill_issue_reported": {
    group: "agent",
    severity: "info",
    mandatoryInapp: false,
    label: "智能体技能问题上报",
  },
  "agent.skill_suggestion": {
    group: "agent",
    severity: "info",
    mandatoryInapp: false,
    label: "技能修订建议（萃取）",
  },
};

export function isNotificationEvent(v: unknown): v is NotificationEvent {
  return typeof v === "string" && v in NOTIFICATION_EVENT_CATALOG;
}

export const NOTIFICATION_GROUP_LABELS: Record<NotificationEventGroup, string> = {
  system: "系统通知",
  workflow: "工作流通知",
  agent: "智能体通知",
};

/** 三分类站内信全组锁定（需求拍板：系统通知默认开启且无法关闭；站内信恒发，UI/接口双守卫） */
export function isMandatoryGroup(_group: NotificationEventGroup): boolean {
  return true;
}

/** 通知意图：事件源只声明语义事件，不感知通道（spec §4.1） */
export interface NotificationIntent {
  event: NotificationEvent;
  recipients: RecipientRef[];
  title: string;
  body: string;
  /** 缺省取事件目录 severity */
  severity?: NotificationSeverity;
  /** 幂等键：同键窗口内只发一条（如 task:{id}:completed） */
  dedupeKey?: string;
  /** 站内跳转路径（/loops/:id 等） */
  link?: string;
  /** 结构化载荷（M2 webhook JSON 体用；只允许显式声明的字符串字段） */
  data?: Record<string, string>;
  /**
   * 通道白名单（2026-10-20 反馈闭环 M3，notifyPolicy.channels 传入）：缺省=全部通道
   * 按用户偏好分发；给定时站内仅在其含 "inapp" 时发，站外取交集（偏好仍须启用）。
   */
  channels?: NotificationChannelId[];
}

export type RecipientRef = { kind: "user"; userId: string };

/** 站内信记录（notifications 表行） */
export interface InAppNotification {
  id: string;
  userId: string;
  event: NotificationEvent;
  severity: NotificationSeverity;
  title: string;
  body: string;
  link?: string;
  dedupeKey?: string;
  readAt?: string;
  createdAt: string;
  /** agent 组事件携带：打开会话批量标已读（已读联动） */
  conversationId?: string;
}

/** 用户订阅偏好条目（notification_prefs 表行） */
export interface NotificationPrefsEntry {
  eventGroup: NotificationEventGroup;
  channel: NotificationChannelId;
  enabled: boolean;
}

export const NotificationPrefInputSchema = z.object({
  eventGroup: z.enum(["system", "workflow", "agent"]),
  channel: z.enum(["inapp", "dingtalk", "webhook", "email"]),
  enabled: z.boolean(),
});

// ===== 地址簿（M2 站外通道投递目标，spec §4.2）=====

/** 地址簿行（notification_addresses 表）。extra 为解密后的机密载荷（webhook 自定义头+签名密钥）。 */
export interface NotificationAddress {
  userId: string;
  channel: OutboundChannelId;
  /** 钉钉 staffId / webhook URL */
  address: string;
  extra?: Record<string, unknown>;
  /** 非空=已完成验证（钉钉手填地址必须验证；webhook 保存即视为已配置） */
  verifiedAt?: string;
  createdAt: string;
}

export const DingTalkVerifyRequestSchema = z.object({
  staffId: z.string().regex(/^[\w.-]{1,64}$/, "staffId 格式无效"),
});

export const WebhookAddressInputSchema = z.object({
  url: z.string().url().max(2048),
  /** 自定义请求头（值属机密，加密落库，任何 API 不回显） */
  headers: z.record(z.string(), z.string().max(1024)).optional(),
});

/** 验证码：6 位数字、10 分钟有效、最多 5 次尝试（spec 决策⑧验证码闭环） */
export const VERIFY_CODE_TTL_MS = 10 * 60_000;
export const VERIFY_CODE_MAX_ATTEMPTS = 5;
