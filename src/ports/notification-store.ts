import type {
  InAppNotification,
  NotificationAddress,
  NotificationChannelId,
  NotificationEventGroup,
  NotificationPrefsEntry,
  OutboundChannelId,
} from "../domain/notification.js";

export interface NotificationListResult {
  items: InAppNotification[];
  total: number;
  unread: number;
}

export type DeliveryStatus = "ok" | "failed" | "skipped";

export interface NotificationDelivery {
  id: string;
  /** 关联站内信行；站外独发（站内被偏好关闭）时可为空 */
  notificationId?: string;
  channel: OutboundChannelId;
  /** 冗余事件与标题（列表免联表；站内行可能不存在） */
  event: string;
  title: string;
  status: DeliveryStatus;
  error?: string;
  attempts: number;
  createdAt: string;
}

/** 读侧过滤：事件类型 + link 前缀（智能体技能反馈视图按 link=/agents/:id# 定位） */
export interface NotificationListFilter {
  event?: string;
  linkPrefix?: string;
}

/** 通知存储端口：站内信 + 订阅偏好 + 地址簿 + 投递日志 */
export interface NotificationStore {
  migrate(): void;
  /** 插入站内信；dedupeKey 命中已有记录时不重复插入，返回 "duplicate" */
  insertInApp(n: InAppNotification): Promise<"inserted" | "duplicate">;
  list(
    userId: string,
    opts: { limit: number; offset: number; unreadOnly?: boolean; filter?: NotificationListFilter },
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

  // ===== 地址簿（extra 机密由实现透明加解密）=====
  putAddress(entry: {
    userId: string;
    channel: OutboundChannelId;
    address: string;
    extra?: Record<string, unknown>;
    verifiedAt?: string;
  }): Promise<void>;
  getAddress(userId: string, channel: OutboundChannelId): Promise<NotificationAddress | undefined>;
  deleteAddress(userId: string, channel: OutboundChannelId): Promise<void>;
  /** 已登记同一地址的用户清单（钉钉 staffId 防重复认领） */
  findAddressOwners(channel: OutboundChannelId, address: string): Promise<string[]>;

  // ===== 投递日志 =====
  insertDelivery(d: NotificationDelivery): Promise<void>;
  listDeliveries(limit: number): Promise<NotificationDelivery[]>;
}
