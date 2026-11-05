import type { Database } from "better-sqlite3";
import type {
  InAppNotification,
  NotificationAddress,
  NotificationChannelId,
  NotificationEvent,
  NotificationEventGroup,
  NotificationPrefsEntry,
  NotificationSeverity,
  OutboundChannelId,
} from "../domain/notification.js";
import type {
  DeliveryStatus,
  NotificationDelivery,
  NotificationListFilter,
  NotificationListResult,
  NotificationStore,
} from "../ports/notification-store.js";

/** extra 机密透明加解密契约（SecretCipher 子集） */
interface ExtraCipher {
  encrypt(plain: string): string;
  decrypt(blob: string): string;
}

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

interface AddressRow {
  userId: string;
  channel: string;
  address: string;
  extra: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

interface DeliveryRow {
  id: string;
  notificationId: string | null;
  channel: string;
  event: string;
  title: string;
  status: string;
  error: string | null;
  attempts: number;
  createdAt: string;
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
  constructor(
    private readonly db: Database,
    private readonly cipher?: ExtraCipher,
  ) {}

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

      CREATE TABLE IF NOT EXISTS notification_trim_stats (
        userId TEXT NOT NULL,
        eventGroup TEXT NOT NULL,
        channel TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        lastNotifiedAt TEXT,
        lastAt TEXT NOT NULL,
        PRIMARY KEY (userId, eventGroup, channel)
      );

      CREATE TABLE IF NOT EXISTS notification_addresses (
        userId TEXT NOT NULL,
        channel TEXT NOT NULL,
        address TEXT NOT NULL,
        extra TEXT,
        verifiedAt TEXT,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (userId, channel)
      );
    `);
    this.migrateDeliveries();
    this.migrateNotif20261105();
  }

  /**
   * 2026-11-05 统一通知设计迁移（幂等）：
   * ① notifications 加 conversationId 列（agent.replied 已读联动：打开会话批量标已读）；
   * ② 订阅偏好 7 组 → 3 类归并（task→agent、loop→workflow、account/feedback/deploy→system、
   *    share→agent、system 同名保留），同 (user,新组,channel) 多行按 OR 合并，inapp 全部刷为开；
   * ③ 若无旧组值则跳过（幂等）。
   */
  private migrateNotif20261105(): void {
    const nCols = (
      this.db.prepare("PRAGMA table_info(notifications)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (nCols.length > 0 && !nCols.includes("conversationId")) {
      this.db.exec("ALTER TABLE notifications ADD COLUMN conversationId TEXT");
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_notifications_conversation ON notifications(conversationId, userId, readAt)",
      );
    }

    const LEGACY_GROUPS = ["task", "loop", "account", "feedback", "deploy", "share"];
    const hasLegacy = this.db
      .prepare(
        `SELECT COUNT(*) n FROM notification_prefs WHERE eventGroup IN (${LEGACY_GROUPS.map(() => "?").join(",")})`,
      )
      .get(...LEGACY_GROUPS) as { n: number };
    if (!hasLegacy.n) return;

    const MAPPING: Record<string, string> = {
      task: "agent",
      loop: "workflow",
      account: "system",
      feedback: "system",
      deploy: "system",
      share: "agent",
      system: "system",
    };
    const rows = this.db
      .prepare("SELECT userId, eventGroup, channel, enabled FROM notification_prefs")
      .all() as Array<{ userId: string; eventGroup: string; channel: string; enabled: number }>;
    const merged = new Map<string, { userId: string; group: string; channel: string; enabled: number }>();
    for (const r of rows) {
      const group = MAPPING[r.eventGroup] ?? r.eventGroup;
      const key = `${r.userId}|${group}|${r.channel}`;
      const prev = merged.get(key);
      const enabled = r.channel === "inapp" ? 1 : Math.max(prev?.enabled ?? 0, r.enabled);
      merged.set(key, { userId: r.userId, group, channel: r.channel, enabled });
    }
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM notification_prefs");
      const ins = this.db.prepare(
        "INSERT INTO notification_prefs (userId, eventGroup, channel, enabled) VALUES (?, ?, ?, ?)",
      );
      for (const m of merged.values()) {
        ins.run(m.userId, m.group, m.channel, m.enabled);
      }
    });
    tx();
  }

  /** deliveries 升级：M1 旧表 notificationId NOT NULL 且无 event/title 冗余列。
   *  投递日志属可弃观测数据（M1 从未写入），检测到旧结构直接重建。 */
  private migrateDeliveries(): void {
    const cols = (
      this.db.prepare("PRAGMA table_info(notification_deliveries)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    if (cols.length > 0 && !cols.includes("event")) {
      this.db.exec("DROP TABLE notification_deliveries");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id TEXT PRIMARY KEY,
        notificationId TEXT,
        channel TEXT NOT NULL,
        event TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_created
        ON notification_deliveries(createdAt DESC);
    `);
  }

  async insertInApp(n: InAppNotification): Promise<"inserted" | "duplicate"> {
    const result = this.db
      .prepare(
        `INSERT INTO notifications (id, userId, event, severity, title, body, link, dedupeKey, readAt, createdAt, conversationId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        (n as { conversationId?: string }).conversationId ?? null,
      );
    return result.changes > 0 ? "inserted" : "duplicate";
  }

  async list(
    userId: string,
    opts: {
      limit: number;
      offset: number;
      unreadOnly?: boolean;
      filter?: NotificationListFilter;
    },
  ): Promise<NotificationListResult> {
    const conditions = ["userId = ?"];
    if (opts.unreadOnly) conditions.push("readAt IS NULL");
    if (opts.filter?.event) conditions.push("event = ?");
    if (opts.filter?.linkPrefix) conditions.push("link LIKE ? || '%'");
    const where = `WHERE ${conditions.join(" AND ")}`;
    const args: (string | number)[] = [userId];
    if (opts.filter?.event) args.push(opts.filter.event);
    if (opts.filter?.linkPrefix) args.push(opts.filter.linkPrefix);
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

  /** 被裁剪累计计数（拍板 D8）：upsert count+1，返回累计值 */
  async bumpTrimStat(userId: string, eventGroup: string, channel: string, at: string): Promise<number> {
    const row = this.db
      .prepare(
        `INSERT INTO notification_trim_stats (userId, eventGroup, channel, count, lastNotifiedAt, lastAt)
         VALUES (?, ?, ?, 1, NULL, ?)
         ON CONFLICT(userId, eventGroup, channel)
         DO UPDATE SET count = count + 1, lastAt = excluded.lastAt
         RETURNING count`,
      )
      .get(userId, eventGroup, channel, at) as { count: number };
    return row.count;
  }

  /** 已读联动：打开会话把该会话全部未读通知标已读 */
  async markReadByConversation(userId: string, conversationId: string): Promise<number> {
    const result = this.db
      .prepare(
        "UPDATE notifications SET readAt = ? WHERE conversationId = ? AND userId = ? AND readAt IS NULL",
      )
      .run(new Date().toISOString(), conversationId, userId);
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

  // ===== 地址簿 =====

  async putAddress(entry: {
    userId: string;
    channel: OutboundChannelId;
    address: string;
    extra?: Record<string, unknown>;
    verifiedAt?: string;
  }): Promise<void> {
    const extraBlob = entry.extra
      ? this.cipher
        ? this.cipher.encrypt(JSON.stringify(entry.extra))
        : JSON.stringify(entry.extra)
      : null;
    this.db
      .prepare(
        `INSERT INTO notification_addresses (userId, channel, address, extra, verifiedAt, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(userId, channel) DO UPDATE SET
           address = excluded.address, extra = excluded.extra, verifiedAt = excluded.verifiedAt`,
      )
      .run(
        entry.userId,
        entry.channel,
        entry.address,
        extraBlob,
        entry.verifiedAt ?? null,
        new Date().toISOString(),
      );
  }

  async getAddress(
    userId: string,
    channel: OutboundChannelId,
  ): Promise<NotificationAddress | undefined> {
    const row = this.db
      .prepare("SELECT * FROM notification_addresses WHERE userId = ? AND channel = ?")
      .get(userId, channel) as AddressRow | undefined;
    return row ? this.rowToAddress(row) : undefined;
  }

  async deleteAddress(userId: string, channel: OutboundChannelId): Promise<void> {
    this.db
      .prepare("DELETE FROM notification_addresses WHERE userId = ? AND channel = ?")
      .run(userId, channel);
  }

  async findAddressOwners(channel: OutboundChannelId, address: string): Promise<string[]> {
    return (
      this.db
        .prepare("SELECT userId FROM notification_addresses WHERE channel = ? AND address = ?")
        .all(channel, address) as Array<{ userId: string }>
    ).map((r) => r.userId);
  }

  private rowToAddress(r: AddressRow): NotificationAddress {
    let extra: Record<string, unknown> | undefined;
    if (r.extra) {
      try {
        const plain = this.cipher ? this.cipher.decrypt(r.extra) : r.extra;
        const parsed: unknown = JSON.parse(plain);
        if (parsed && typeof parsed === "object") extra = parsed as Record<string, unknown>;
      } catch {
        // 解密/解析失败按无机密处理（密钥轮换后的兜底，不阻塞地址本身）
      }
    }
    return {
      userId: r.userId,
      channel: r.channel as OutboundChannelId,
      address: r.address,
      extra,
      verifiedAt: r.verifiedAt ?? undefined,
      createdAt: r.createdAt,
    };
  }

  // ===== 投递日志 =====

  async insertDelivery(d: NotificationDelivery): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO notification_deliveries
           (id, notificationId, channel, event, title, status, error, attempts, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.id,
        d.notificationId ?? null,
        d.channel,
        d.event,
        d.title,
        d.status,
        d.error ?? null,
        d.attempts,
        d.createdAt,
      );
  }

  async listDeliveries(limit: number): Promise<NotificationDelivery[]> {
    return (
      this.db
        .prepare("SELECT * FROM notification_deliveries ORDER BY createdAt DESC, id DESC LIMIT ?")
        .all(limit) as DeliveryRow[]
    ).map((r) => ({
      id: r.id,
      notificationId: r.notificationId ?? undefined,
      channel: r.channel as OutboundChannelId,
      event: r.event,
      title: r.title,
      status: r.status as DeliveryStatus,
      error: r.error ?? undefined,
      attempts: r.attempts,
      createdAt: r.createdAt,
    }));
  }
}
