import type { Database } from "better-sqlite3";
import type { Trigger, TriggerInput } from "../domain/trigger.js";
import { TriggerSchema } from "../domain/trigger.js";
import type { TriggerStore } from "../ports/trigger-store.js";
import { NotFoundError } from "../util/errors.js";

interface TriggerRow {
  id: string;
  ownerId: string;
  name: string;
  type: string;
  config: string;
  /** git 触发器运行时状态（JSON：{lastSha}）；其余类型为空 */
  lastState: string | null;
  createdAt: string;
  updatedAt: string;
}

export class SqliteTriggerStore implements TriggerStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, name TEXT NOT NULL,
        type TEXT NOT NULL, config TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )
    `);
    // v2 git 触发器（2026-09-30）：既有库补 lastState 列
    const cols = this.db.prepare("PRAGMA table_info(triggers)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "lastState")) {
      this.db.exec("ALTER TABLE triggers ADD COLUMN lastState TEXT");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_triggers_owner ON triggers(ownerId)");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_triggers_type_path ON triggers(type, json_extract(config, '$.hook.path'))",
    );
  }

  private marshal(t: Trigger): { type: string; config: string } {
    const cfg =
      t.type === "scheduler"
        ? { scheduler: t.scheduler }
        : t.type === "event"
          ? { event: t.event }
          : t.type === "git"
            ? { git: t.git }
            : { hook: t.hook };
    return { type: t.type, config: JSON.stringify(cfg) };
  }

  private unmarshal(row: TriggerRow): Trigger {
    const cfg = JSON.parse(row.config);
    return TriggerSchema.parse({
      id: row.id,
      ownerId: row.ownerId,
      name: row.name,
      type: row.type,
      scheduler: cfg.scheduler,
      hook: cfg.hook,
      event: cfg.event,
      git: cfg.git,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  async create(input: TriggerInput): Promise<Trigger> {
    const now = new Date().toISOString();
    const t: Trigger = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    const m = this.marshal(t);
    this.db
      .prepare(
        "INSERT INTO triggers (id, ownerId, name, type, config, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)",
      )
      .run(t.id, t.ownerId, t.name, m.type, m.config, t.createdAt, t.updatedAt);
    return t;
  }

  async get(id: string): Promise<Trigger | undefined> {
    const row = this.db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as
      | TriggerRow
      | undefined;
    return row ? this.unmarshal(row) : undefined;
  }

  async listByOwner(ownerId: string): Promise<Trigger[]> {
    const rows = this.db
      .prepare("SELECT * FROM triggers WHERE ownerId = ? ORDER BY updatedAt DESC")
      .all(ownerId) as TriggerRow[];
    return rows.map((r) => this.unmarshal(r));
  }

  async listAll(): Promise<Trigger[]> {
    const rows = this.db.prepare("SELECT * FROM triggers").all() as TriggerRow[];
    return rows.map((r) => this.unmarshal(r));
  }

  async findByHookPath(path: string): Promise<Trigger | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM triggers WHERE type = 'hook' AND json_extract(config, '$.hook.path') = ?`,
      )
      .get(path) as TriggerRow | undefined;
    return row ? this.unmarshal(row) : undefined;
  }

  async update(id: string, patch: Partial<TriggerInput>): Promise<Trigger> {
    const cur = await this.get(id);
    if (!cur) throw new NotFoundError("TRIGGER_NOT_FOUND", `trigger 不存在: ${id}`);
    const next: Trigger = {
      ...cur,
      ...patch,
      id: cur.id,
      ownerId: cur.ownerId,
      createdAt: cur.createdAt,
      updatedAt: new Date().toISOString(),
    };
    const m = this.marshal(next);
    this.db
      .prepare("UPDATE triggers SET name=?, type=?, config=?, updatedAt=? WHERE id=?")
      .run(next.name, m.type, m.config, next.updatedAt, next.id);
    return next;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM triggers WHERE id = ?").run(id);
  }

  async countWorkflowsReferencing(triggerId: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM workflows WHERE triggerId = ?")
      .get(triggerId) as { n: number };
    return row.n;
  }

  /** git 触发器：上次已见分支 HEAD（首见返回 undefined=建立基线，不触发） */
  async getGitLastSha(id: string): Promise<string | undefined> {
    const row = this.db.prepare("SELECT lastState FROM triggers WHERE id = ?").get(id) as
      | { lastState: string | null }
      | undefined;
    if (!row?.lastState) return undefined;
    try {
      const parsed = JSON.parse(row.lastState) as { lastSha?: string };
      return parsed.lastSha;
    } catch {
      return undefined;
    }
  }

  async setGitLastSha(id: string, sha: string): Promise<void> {
    this.db
      .prepare("UPDATE triggers SET lastState = ? WHERE id = ?")
      .run(JSON.stringify({ lastSha: sha }), id);
  }
}
