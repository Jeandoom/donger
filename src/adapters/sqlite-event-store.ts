import type { Database } from "better-sqlite3";
import type { Event, EventInput } from "../domain/event.js";
import { EventSchema, generateCallPath } from "../domain/event.js";
import type { EventStore } from "../ports/event-store.js";
import { NotFoundError } from "../util/errors.js";

interface EventRow {
  id: string;
  ownerId: string;
  name: string;
  type: string;
  config: string;
  lastFiredAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class SqliteEventStore implements EventStore {
  constructor(private readonly db: Database) {}

  /**
   * 迁移：建 events 表 + 存量 triggers 一次性映射（spec §9.1）。
   * scheduler→schedule(conditional，存量 source 必填故全为有条件)；hook→call（path 全部
   * 重新随机生成——D2 拍板无外部系统在用）；event→system；git→删行（GitWatcher 退役，
   * 引用它的 workflow 由 workflow-store 迁移置 enabled=0）。
   * 调用顺序约束：须先于 workflow-store / run-store 迁移执行。
   */
  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, name TEXT NOT NULL,
        type TEXT NOT NULL, config TEXT NOT NULL,
        lastFiredAt TEXT, nextRunAt TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_owner ON events(ownerId)");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_events_type_path ON events(type, json_extract(config, '$.call.path'))",
    );

    const hasTriggers = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='triggers'")
      .get();
    if (!hasTriggers) return;
    const rows = this.db.prepare("SELECT * FROM triggers").all() as Array<{
      id: string;
      ownerId: string;
      name: string;
      type: string;
      config: string;
      createdAt: string;
      updatedAt: string;
    }>;
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO events (id, ownerId, name, type, config, lastFiredAt, nextRunAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    const droppedGit: string[] = [];
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        if (r.type === "git") {
          droppedGit.push(r.id);
          continue;
        }
        const cfg = JSON.parse(r.config) as Record<string, unknown>;
        let type: string;
        let nextCfg: Record<string, unknown>;
        if (r.type === "scheduler") {
          const sched = cfg.scheduler as Record<string, unknown> | undefined;
          type = "schedule";
          nextCfg = {
            cron: sched?.cron ?? "@daily",
            mode: "conditional",
            source: sched?.source,
            matcher: sched?.matcher,
          };
        } else if (r.type === "hook") {
          const hook = cfg.hook as Record<string, unknown> | undefined;
          type = "call";
          nextCfg = {
            path: generateCallPath(),
            methods: ["GET", "POST"],
            responseStatus: hook?.responseStatus ?? 200,
            responseBody: hook?.responseBody ?? "",
            matcher: hook?.matcher ?? { kind: "always" },
          };
        } else {
          // event → system
          const ev = cfg.event as Record<string, unknown> | undefined;
          type = "system";
          nextCfg = {
            name: ev?.name ?? "feedback.created",
            matcher: ev?.matcher ?? { kind: "always" },
          };
        }
        insert.run(
          r.id,
          r.ownerId,
          r.name,
          type,
          JSON.stringify({ [type]: nextCfg }),
          null,
          null,
          r.createdAt,
          r.updatedAt,
        );
      }
    });
    tx();
    if (droppedGit.length > 0) {
      this.db.prepare("DELETE FROM triggers WHERE type = 'git'").run();
    }
    this.db.exec("DROP TABLE IF EXISTS triggers");
  }

  private marshal(t: Event): { type: string; config: string } {
    const cfg =
      t.type === "system"
        ? { system: t.system }
        : t.type === "schedule"
          ? { schedule: t.schedule }
          : { call: t.call };
    return { type: t.type, config: JSON.stringify(cfg) };
  }

  private unmarshal(row: EventRow): Event {
    const cfg = JSON.parse(row.config);
    return EventSchema.parse({
      id: row.id,
      ownerId: row.ownerId,
      name: row.name,
      type: row.type,
      system: cfg.system,
      schedule: cfg.schedule,
      call: cfg.call,
      lastFiredAt: row.lastFiredAt,
      nextRunAt: row.nextRunAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  async create(input: EventInput & { ownerId: string }): Promise<Event> {
    const now = new Date().toISOString();
    const event: Event = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    const m = this.marshal(event);
    this.db
      .prepare(
        "INSERT INTO events (id, ownerId, name, type, config, lastFiredAt, nextRunAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        event.id,
        event.ownerId,
        event.name,
        m.type,
        m.config,
        event.lastFiredAt ?? null,
        event.nextRunAt ?? null,
        event.createdAt,
        event.updatedAt,
      );
    return event;
  }

  async get(id: string): Promise<Event | undefined> {
    const row = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as
      | EventRow
      | undefined;
    return row ? this.unmarshal(row) : undefined;
  }

  async listByOwner(ownerId: string): Promise<Event[]> {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE ownerId = ? ORDER BY updatedAt DESC")
      .all(ownerId) as EventRow[];
    return rows.map((r) => this.unmarshal(r));
  }

  async listAll(): Promise<Event[]> {
    const rows = this.db.prepare("SELECT * FROM events").all() as EventRow[];
    return rows.map((r) => this.unmarshal(r));
  }

  async findByCallPath(path: string): Promise<Event | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM events WHERE type = 'call' AND json_extract(config, '$.call.path') = ?`,
      )
      .get(path) as EventRow | undefined;
    return row ? this.unmarshal(row) : undefined;
  }

  async update(id: string, patch: EventInput): Promise<Event> {
    const cur = await this.get(id);
    if (!cur) throw new NotFoundError("EVENT_NOT_FOUND", `事件不存在: ${id}`);
    // call path 服务端所有（D2）：更新不换路径，外部回调地址稳定
    const next: Event = {
      ...cur,
      ...patch,
      call: patch.call ? { ...patch.call, path: cur.call?.path ?? patch.call.path } : cur.call,
      id: cur.id,
      ownerId: cur.ownerId,
      lastFiredAt: cur.lastFiredAt,
      nextRunAt: cur.nextRunAt,
      createdAt: cur.createdAt,
      updatedAt: new Date().toISOString(),
    };
    const m = this.marshal(next);
    this.db
      .prepare("UPDATE events SET name=?, type=?, config=?, updatedAt=? WHERE id=?")
      .run(next.name, m.type, m.config, next.updatedAt, next.id);
    return next;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM events WHERE id = ?").run(id);
  }

  async updateRuntimeState(
    id: string,
    patch: Partial<Pick<Event, "lastFiredAt" | "nextRunAt">>,
  ): Promise<void> {
    this.db
      .prepare(
        "UPDATE events SET lastFiredAt=COALESCE(?, lastFiredAt), nextRunAt=COALESCE(?, nextRunAt) WHERE id=?",
      )
      .run(patch.lastFiredAt ?? null, patch.nextRunAt ?? null, id);
  }
}
