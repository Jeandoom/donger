import { z } from "zod";

/**
 * 通知域模型（spec 2026-09-28-notification-module-design）。
 *
 * 事件目录是受控枚举：NotificationService 对未登记事件 fail-closed 拒发。
 * 新增通知场景必须先在此登记（含分组/severity/是否强制站内信），禁止各处随手字符串扩散。
 */

export type NotificationEvent =
  | "task.completed"
  | "task.failed"
  | "loop.run_succeeded"
  | "loop.run_failed"
  | "loop.queue_overflow"
  | "eviction.notice"
  | "user.role_changed"
  | "credential.missing"
  | "feedback.replied"
  | "approval.requested"
  | "system.announcement"
  | "deploy.detected"
  | "deploy.succeeded"
  | "deploy.failed"
  | "agent.skill_issue_reported";

/** 订阅偏好按事件组粒度（用户不感知单事件开关）；组×通道成矩阵 */
export type NotificationEventGroup =
  | "task"
  | "loop"
  | "system"
  | "account"
  | "feedback"
  | "deploy"
  | "share";

export type NotificationSeverity = "info" | "warn" | "critical";

/** 投递通道：站内信恒开；站外通道用户显式订阅（opt-in，spec §4.4） */
export type NotificationChannelId = "inapp" | "dingtalk" | "webhook";

export type OutboundChannelId = Exclude<NotificationChannelId, "inapp">;

export const OUTBOUND_CHANNELS: OutboundChannelId[] = ["dingtalk", "webhook"];

export interface NotificationEventSpec {
  group: NotificationEventGroup;
  severity: NotificationSeverity;
  /** 强制站内信：安全相关通知，用户偏好不可关闭（决策⑤：仅 user.role_changed） */
  mandatoryInapp: boolean;
  label: string;
}

export const NOTIFICATION_EVENT_CATALOG: Record<NotificationEvent, NotificationEventSpec> = {
  "task.completed": { group: "task", severity: "info", mandatoryInapp: false, label: "任务完成" },
  "task.failed": { group: "task", severity: "warn", mandatoryInapp: false, label: "任务失败" },
  "loop.run_succeeded": {
    group: "loop",
    severity: "info",
    mandatoryInapp: false,
    label: "循环任务运行成功",
  },
  "loop.run_failed": {
    group: "loop",
    severity: "critical",
    mandatoryInapp: false,
    label: "循环任务运行失败",
  },
  "loop.queue_overflow": {
    group: "loop",
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
    group: "account",
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
    group: "feedback",
    severity: "info",
    mandatoryInapp: false,
    label: "反馈有新回复",
  },
  "approval.requested": {
    group: "task",
    severity: "warn",
    // 强制站内信：审批不决议 = workflow 永久挂起（2026-10-10 生产实证），不允许被组偏好静音
    mandatoryInapp: true,
    label: "等待审批",
  },
  "system.announcement": {
    group: "system",
    severity: "info",
    mandatoryInapp: false,
    label: "系统公告",
  },
  "deploy.detected": {
    group: "deploy",
    severity: "warn",
    mandatoryInapp: false,
    label: "发现新提交待部署",
  },
  "deploy.succeeded": {
    group: "deploy",
    severity: "info",
    mandatoryInapp: false,
    label: "部署成功",
  },
  "deploy.failed": {
    group: "deploy",
    severity: "critical",
    mandatoryInapp: false,
    label: "部署失败",
  },
  "agent.skill_issue_reported": {
    group: "share",
    severity: "info",
    mandatoryInapp: false,
    label: "智能体技能问题上报",
  },
};

export function isNotificationEvent(v: unknown): v is NotificationEvent {
  return typeof v === "string" && v in NOTIFICATION_EVENT_CATALOG;
}

export const NOTIFICATION_GROUP_LABELS: Record<NotificationEventGroup, string> = {
  task: "任务结果",
  loop: "循环任务",
  system: "系统提醒",
  account: "账号安全",
  feedback: "反馈回复",
  deploy: "部署运维",
  share: "分享协作",
};

/** account 组整体强制站内信（组内事件 mandatoryInapp=true），订阅矩阵中锁定为开 */
export function isMandatoryGroup(group: NotificationEventGroup): boolean {
  return group === "account";
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
}

/** 用户订阅偏好条目（notification_prefs 表行） */
export interface NotificationPrefsEntry {
  eventGroup: NotificationEventGroup;
  channel: NotificationChannelId;
  enabled: boolean;
}

export const NotificationPrefInputSchema = z.object({
  eventGroup: z.enum(["task", "loop", "system", "account", "feedback", "deploy", "share"]),
  channel: z.enum(["inapp", "dingtalk", "webhook"]),
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
