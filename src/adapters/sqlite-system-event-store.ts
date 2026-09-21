import type { Database } from "better-sqlite3";
import type { SystemEvent, SystemEventStore } from "../ports/system-event-store.js";

export class SqliteSystemEventStore implements SystemEventStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_events (
        id             TEXT PRIMARY KEY,
        type           TEXT NOT NULL,
        actorId        TEXT NOT NULL,
        actorName      TEXT NOT NULL,
        targetUserId   TEXT,
        targetUserName TEXT,
        detail         TEXT NOT NULL,
        createdAt      TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_system_events_created ON system_events(createdAt)");
  }

  async record(
    e: Omit<SystemEvent, "id" | "createdAt"> & { createdAt?: string },
  ): Promise<SystemEvent> {
    const rec: SystemEvent = {
      ...e,
      id: crypto.randomUUID(),
      createdAt: e.createdAt ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO system_events (id, type, actorId, actorName, targetUserId, targetUserName, detail, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.type,
        rec.actorId,
        rec.actorName,
        rec.targetUserId ?? null,
        rec.targetUserName ?? null,
        rec.detail,
        rec.createdAt,
      );
    return rec;
  }

  async list(limit = 200): Promise<SystemEvent[]> {
    const rows = this.db
      .prepare(
        `SELECT id, type, actorId, actorName, targetUserId, targetUserName, detail, createdAt
         FROM system_events ORDER BY createdAt DESC, id DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      type: string;
      actorId: string;
      actorName: string;
      targetUserId: string | null;
      targetUserName: string | null;
      detail: string;
      createdAt: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      actorId: r.actorId,
      actorName: r.actorName,
      targetUserId: r.targetUserId ?? undefined,
      targetUserName: r.targetUserName ?? undefined,
      detail: r.detail,
      createdAt: r.createdAt,
    }));
  }
}
