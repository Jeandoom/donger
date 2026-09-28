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
  | "eviction.notice"
  | "user.role_changed"
  | "credential.missing"
  | "feedback.replied"
  | "system.announcement";

/** 订阅偏好按事件组粒度（用户不感知单事件开关）；M2 站外通道加入后组×通道成矩阵 */
export type NotificationEventGroup = "task" | "loop" | "system" | "account" | "feedback";

export type NotificationSeverity = "info" | "warn" | "critical";

/** 投递通道；M1 仅站内信，M2 起扩展 dingtalk/webhook/email/webpush */
export type NotificationChannelId = "inapp";

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
  "system.announcement": {
    group: "system",
    severity: "info",
    mandatoryInapp: false,
    label: "系统公告",
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
  eventGroup: z.enum(["task", "loop", "system", "account", "feedback"]),
  channel: z.enum(["inapp"]),
  enabled: z.boolean(),
});
