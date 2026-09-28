// 通知模块数据获取 + 词表映射（UI 在 NotificationPage）。
// 后端契约见 docs/superpowers/specs/2026-09-28-notification-module-design.md §4。

import { apiFetch } from "./auth";

export type NotificationSeverity = "info" | "warn" | "critical";
export type NotificationEventGroup = "task" | "loop" | "system" | "account" | "feedback";

export interface NotificationItem {
  id: string;
  event: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  link?: string;
  readAt?: string;
  createdAt: string;
}

export interface NotificationListResult {
  items: NotificationItem[];
  total: number;
  unread: number;
}

export interface NotificationPrefGroup {
  eventGroup: NotificationEventGroup;
  label: string;
  /** 账号安全组强制站内信：开关锁定为开（决策⑤） */
  mandatory: boolean;
  inapp: boolean;
}

export const SEVERITY_LABELS: Record<NotificationSeverity, string> = {
  info: "提示",
  warn: "警告",
  critical: "严重",
};

export const SEVERITY_TONES: Record<NotificationSeverity, string> = {
  info: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  critical: "text-red-600 dark:text-red-400",
};

/** 通知列表变化后广播（导航徽标即时刷新），避免固定短轮询 */
export function notifyNotificationsChanged(): void {
  window.dispatchEvent(new Event("donger:notifications-changed"));
}

export async function fetchNotifications(opts: {
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
}): Promise<NotificationListResult> {
  const q = new URLSearchParams();
  if (opts.limit !== undefined) q.set("limit", String(opts.limit));
  if (opts.offset !== undefined) q.set("offset", String(opts.offset));
  if (opts.unreadOnly) q.set("unread", "1");
  const suffix = q.toString() ? `?${q.toString()}` : "";
  const r = await apiFetch(`/api/notifications${suffix}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as NotificationListResult;
}

export async function fetchUnreadCount(): Promise<number> {
  const r = await apiFetch("/api/notifications/unread-count");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as { count: number };
  return data.count;
}

export async function markNotificationRead(id: string): Promise<void> {
  const r = await apiFetch("/api/notifications/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  notifyNotificationsChanged();
}

export async function markAllNotificationsRead(): Promise<number> {
  const r = await apiFetch("/api/notifications/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ all: true }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as { updated: number };
  notifyNotificationsChanged();
  return data.updated;
}

export async function fetchNotificationPrefs(): Promise<NotificationPrefGroup[]> {
  const r = await apiFetch("/api/notifications/prefs");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as { groups: NotificationPrefGroup[] };
  return data.groups;
}

export async function setNotificationPref(
  eventGroup: NotificationEventGroup,
  enabled: boolean,
): Promise<void> {
  const r = await apiFetch("/api/notifications/prefs", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventGroup, channel: "inapp", enabled }),
  });
  if (!r.ok) {
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `HTTP ${r.status}`);
  }
}
