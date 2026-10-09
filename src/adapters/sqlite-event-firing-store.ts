import type { Database } from "better-sqlite3";
import type { EventFiring } from "../domain/event-firing.js";
import { EventFiringSchema } from "../domain/event-firing.js";
import type { EventFiringStore } from "../ports/event-firing-store.js";

interface EventFiringRow {
  id: string;
  eventId: string;
  ownerId: string;
  source: string;
  context: string;
  matchedWorkflowCount: number;
  firedAt: string;
}

export class SqliteEventFiringStore implements EventFiringStore {
  constructor(private readonly db: Database) {}

  /** 触发记录表（永久保留 D5：无任何按时间清理；启动恢复不触碰本表） */
  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_firings (
        id TEXT PRIMARY KEY, eventId TEXT NOT NULL, ownerId TEXT NOT NULL,
        source TEXT NOT NULL, context TEXT NOT NULL,
        matchedWorkflowCount INTEGER NOT NULL DEFAULT 0,
        firedAt TEXT NOT NULL
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_event_firings_event ON event_firings(eventId, firedAt DESC)",
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_event_firings_owner ON event_firings(ownerId)");
  }

  private unmarshal(row: EventFiringRow): EventFiring {
    return EventFiringSchema.parse(row);
  }

  async insert(firing: EventFiring): Promise<EventFiring> {
    const f = EventFiringSchema.parse(firing);
    this.db
      .prepare(
        "INSERT INTO event_firings (id, eventId, ownerId, source, context, matchedWorkflowCount, firedAt) VALUES (?,?,?,?,?,?,?)",
      )
      .run(f.id, f.eventId, f.ownerId, f.source, f.context, f.matchedWorkflowCount, f.firedAt);
    return f;
  }

  async get(id: string): Promise<EventFiring | undefined> {
    const row = this.db.prepare("SELECT * FROM event_firings WHERE id = ?").get(id) as
      | EventFiringRow
      | undefined;
    return row ? this.unmarshal(row) : undefined;
  }

  async listByEvent(
    eventId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<EventFiring[]> {
    const limit = opts?.limit ?? 50;
    const rows = (
      opts?.before
        ? this.db
            .prepare(
              "SELECT * FROM event_firings WHERE eventId = ? AND firedAt < ? ORDER BY firedAt DESC LIMIT ?",
            )
            .all(eventId, opts.before, limit)
        : this.db
            .prepare("SELECT * FROM event_firings WHERE eventId = ? ORDER BY firedAt DESC LIMIT ?")
            .all(eventId, limit)
    ) as EventFiringRow[];
    return rows.map((r) => this.unmarshal(r));
  }

  async listByOwner(
    ownerId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<EventFiring[]> {
    const limit = opts?.limit ?? 50;
    const rows = (
      opts?.before
        ? this.db
            .prepare(
              "SELECT * FROM event_firings WHERE ownerId = ? AND firedAt < ? ORDER BY firedAt DESC LIMIT ?",
            )
            .all(ownerId, opts.before, limit)
        : this.db
            .prepare("SELECT * FROM event_firings WHERE ownerId = ? ORDER BY firedAt DESC LIMIT ?")
            .all(ownerId, limit)
    ) as EventFiringRow[];
    return rows.map((r) => this.unmarshal(r));
  }
}
