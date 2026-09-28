import type {
  InAppNotification,
  NotificationChannelId,
  NotificationEventGroup,
  NotificationPrefsEntry,
} from "../domain/notification.js";

export interface NotificationListResult {
  items: InAppNotification[];
  total: number;
  unread: number;
}

/** 通知存储端口：站内信 + 订阅偏好（地址簿/投递日志 M2 随站外通道加入） */
export interface NotificationStore {
  migrate(): void;
  /** 插入站内信；dedupeKey 命中已有记录时不重复插入，返回 "duplicate" */
  insertInApp(n: InAppNotification): Promise<"inserted" | "duplicate">;
  list(
    userId: string,
    opts: { limit: number; offset: number; unreadOnly?: boolean },
  ): Promise<NotificationListResult>;
  unreadCount(userId: string): Promise<number>;
  /** 属主校验在 SQL 条件内（userId 过滤）；未命中返回 false */
  markRead(userId: string, id: string): Promise<boolean>;
  markAllRead(userId: string): Promise<number>;
  getPrefs(userId: string): Promise<NotificationPrefsEntry[]>;
  setPref(
    userId: string,
    entry: { eventGroup: NotificationEventGroup; channel: NotificationChannelId; enabled: boolean },
  ): Promise<void>;
}
