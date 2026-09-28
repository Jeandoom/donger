import { redactSecrets } from "../domain/audit.js";
import {
  type InAppNotification,
  isMandatoryGroup,
  isNotificationEvent,
  NOTIFICATION_EVENT_CATALOG,
  type NotificationEventGroup,
  type NotificationIntent,
  type NotificationPrefsEntry,
} from "../domain/notification.js";
import type { NotificationListResult, NotificationStore } from "../ports/notification-store.js";

export interface NotificationServiceDeps {
  store: NotificationStore;
  /** 单用户未读上限：超出后丢弃新通知（防风暴/刷爆）；已读恢复后自动放行 */
  maxUnreadPerUser?: number;
}

/**
 * 通知内核（spec 2026-09-28-notification-module-design §3）：全系统会话外通知的唯一发出点。
 *
 * 流程：事件目录校验（fail-closed）→ 脱敏 → 收件人展开 → 路由合成（强制站内信 ∪ 用户偏好）
 * → 未读上限频控 → 站内信落库（dedupeKey 幂等）。
 * M1 只投递站内信；M2 站外通道在此处的通道分发点插入适配器循环。
 */
export class NotificationService {
  private readonly maxUnread: number;

  constructor(private readonly deps: NotificationServiceDeps) {
    this.maxUnread = deps.maxUnreadPerUser ?? 500;
  }

  async notify(intent: NotificationIntent): Promise<void> {
    // fail-closed：未登记事件直接拒绝（编程错误，宁可炸在发出方也不静默扩散）
    if (!isNotificationEvent(intent.event)) {
      throw new Error(`未登记的通知事件: ${String(intent.event)}`);
    }
    const spec = NOTIFICATION_EVENT_CATALOG[intent.event];
    const severity = intent.severity ?? spec.severity;
    // 内容脱敏 + 截断：通知不是审计载体，禁止携带凭证明文出站
    const title = redactSecrets(intent.title).slice(0, 200);
    const body = redactSecrets(intent.body).slice(0, 1000);
    const userIds = [
      ...new Set(intent.recipients.filter((r) => r.kind === "user").map((r) => r.userId)),
    ];
    for (const userId of userIds) {
      if (!userId || !(await this.enabledFor(userId, spec.group, spec.mandatoryInapp))) continue;
      const unread = await this.deps.store.unreadCount(userId);
      if (unread >= this.maxUnread) {
        console.warn(
          `[notification] 用户 ${userId} 未读已达上限 ${this.maxUnread}，丢弃事件 ${intent.event}`,
        );
        continue;
      }
      const row: InAppNotification = {
        id: crypto.randomUUID(),
        userId,
        event: intent.event,
        severity,
        title,
        body,
        link: intent.link,
        dedupeKey: intent.dedupeKey,
        createdAt: new Date().toISOString(),
      };
      await this.deps.store.insertInApp(row);
    }
  }

  /** 路由合成：强制站内信 > 用户偏好 > 默认开（spec §4.4） */
  private async enabledFor(
    userId: string,
    group: NotificationEventGroup,
    mandatoryInapp: boolean,
  ): Promise<boolean> {
    if (mandatoryInapp) return true;
    const prefs = await this.deps.store.getPrefs(userId);
    const pref = prefs.find((p) => p.eventGroup === group && p.channel === "inapp");
    return pref ? pref.enabled : true;
  }

  // ===== 站内信读侧 API 透传（属主过滤在 store SQL 条件内）=====

  list(
    userId: string,
    opts: { limit: number; offset: number; unreadOnly?: boolean },
  ): Promise<NotificationListResult> {
    return this.deps.store.list(userId, opts);
  }

  unreadCount(userId: string): Promise<number> {
    return this.deps.store.unreadCount(userId);
  }

  markRead(userId: string, id: string): Promise<boolean> {
    return this.deps.store.markRead(userId, id);
  }

  markAllRead(userId: string): Promise<number> {
    return this.deps.store.markAllRead(userId);
  }

  getPrefs(userId: string): Promise<NotificationPrefsEntry[]> {
    return this.deps.store.getPrefs(userId);
  }

  /** 偏好写入：强制组不可关（返回 false 表示被拒），其余 upsert */
  async setPref(userId: string, entry: NotificationPrefsEntry): Promise<boolean> {
    if (!entry.enabled && entry.channel === "inapp" && isMandatoryGroup(entry.eventGroup)) {
      return false;
    }
    await this.deps.store.setPref(userId, entry);
    return true;
  }
}
