import type { Database } from "better-sqlite3";
import type {
  InAppNotification,
  NotificationChannelId,
  NotificationEvent,
  NotificationEventGroup,
  NotificationPrefsEntry,
  NotificationSeverity,
} from "../domain/notification.js";
import type { NotificationListResult, NotificationStore } from "../ports/notification-store.js";

interface NotificationRow {
  id: string;
  userId: string;
  event: string;
  severity: string;
  title: string;
  body: string;
  link: string | null;
  dedupeKey: string | null;
  readAt: string | null;
  createdAt: string;
}

interface PrefRow {
  eventGroup: string;
  channel: string;
  enabled: number;
}

function rowToNotification(r: NotificationRow): InAppNotification {
  return {
    id: r.id,
    userId: r.userId,
    event: r.event as NotificationEvent,
    severity: r.severity as NotificationSeverity,
    title: r.title,
    body: r.body,
    link: r.link ?? undefined,
    dedupeKey: r.dedupeKey ?? undefined,
    readAt: r.readAt ?? undefined,
    createdAt: r.createdAt,
  };
}

export class SqliteNotificationStore implements NotificationStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        event TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        link TEXT,
        dedupeKey TEXT,
        readAt TEXT,
        createdAt TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
        ON notifications(dedupeKey) WHERE dedupeKey IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_notifications_user_time
        ON notifications(userId, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_unread
        ON notifications(userId, readAt);

      CREATE TABLE IF NOT EXISTS notification_prefs (
        userId TEXT NOT NULL,
        eventGroup TEXT NOT NULL,
        channel TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        PRIMARY KEY (userId, eventGroup, channel)
      );

      -- M2 站外通道建表先行（schema 稳定，API 随通道适配器上线）
      CREATE TABLE IF NOT EXISTS notification_addresses (
        userId TEXT NOT NULL,
        channel TEXT NOT NULL,
        address TEXT NOT NULL,
        extra TEXT,
        verifiedAt TEXT,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (userId, channel)
      );

      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id TEXT PRIMARY KEY,
        notificationId TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_notification
        ON notification_deliveries(notificationId);
    `);
  }

  async insertInApp(n: InAppNotification): Promise<"inserted" | "duplicate"> {
    const result = this.db
      .prepare(
        `INSERT INTO notifications (id, userId, event, severity, title, body, link, dedupeKey, readAt, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dedupeKey) WHERE dedupeKey IS NOT NULL DO NOTHING`,
      )
      .run(
        n.id,
        n.userId,
        n.event,
        n.severity,
        n.title,
        n.body,
        n.link ?? null,
        n.dedupeKey ?? null,
        n.readAt ?? null,
        n.createdAt,
      );
    return result.changes > 0 ? "inserted" : "duplicate";
  }

  async list(
    userId: string,
    opts: { limit: number; offset: number; unreadOnly?: boolean },
  ): Promise<NotificationListResult> {
    const where = opts.unreadOnly ? "WHERE userId = ? AND readAt IS NULL" : "WHERE userId = ?";
    const args: (string | number)[] = [userId];
    const items = (
      this.db
        .prepare(
          `SELECT * FROM notifications ${where} ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?`,
        )
        .all(...args, opts.limit, opts.offset) as NotificationRow[]
    ).map(rowToNotification);
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM notifications ${where}`).get(...args) as {
        c: number;
      }
    ).c;
    const unread = await this.unreadCount(userId);
    return { items, total, unread };
  }

  async unreadCount(userId: string): Promise<number> {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM notifications WHERE userId = ? AND readAt IS NULL")
        .get(userId) as { c: number }
    ).c;
  }

  async markRead(userId: string, id: string): Promise<boolean> {
    const result = this.db
      .prepare("UPDATE notifications SET readAt = ? WHERE id = ? AND userId = ? AND readAt IS NULL")
      .run(new Date().toISOString(), id, userId);
    return result.changes > 0;
  }

  async markAllRead(userId: string): Promise<number> {
    const result = this.db
      .prepare("UPDATE notifications SET readAt = ? WHERE userId = ? AND readAt IS NULL")
      .run(new Date().toISOString(), userId);
    return result.changes;
  }

  async getPrefs(userId: string): Promise<NotificationPrefsEntry[]> {
    return (
      this.db.prepare("SELECT * FROM notification_prefs WHERE userId = ?").all(userId) as PrefRow[]
    ).map((r) => ({
      eventGroup: r.eventGroup as NotificationEventGroup,
      channel: r.channel as NotificationChannelId,
      enabled: r.enabled === 1,
    }));
  }

  async setPref(
    userId: string,
    entry: {
      eventGroup: NotificationEventGroup;
      channel: NotificationChannelId;
      enabled: boolean;
    },
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO notification_prefs (userId, eventGroup, channel, enabled)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(userId, eventGroup, channel) DO UPDATE SET enabled = excluded.enabled`,
      )
      .run(userId, entry.eventGroup, entry.channel, entry.enabled ? 1 : 0);
  }
}
