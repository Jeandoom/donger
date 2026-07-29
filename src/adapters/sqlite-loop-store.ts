import type { Database } from "better-sqlite3";
import type { Loop, LoopInput, LoopRun } from "../domain/loop.js";
import { LoopRunSchema, LoopSchema } from "../domain/loop.js";
import type { LoopStore } from "../ports/loop-store.js";

interface LoopRow {
  id: string;
  ownerId: string;
  name: string;
  workflowId: string;
  enabled: number;
  tags: string;
  lastRunId: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LoopRunRow {
  id: string;
  loopId: string;
  workflowId: string;
  triggerId: string;
  agentId: string;
  status: string;
  triggerOutput: string | null;
  renderedPrompt: string | null;
  agentConversationId: string | null;
  loopDir: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export class SqliteLoopStore implements LoopStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS loops (
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, name TEXT NOT NULL,
        workflowId TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        lastRunId TEXT, lastRunAt TEXT, nextRunAt TEXT, lastError TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_loops_owner ON loops(ownerId)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_loops_workflow ON loops(workflowId)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_loops_enabled ON loops(enabled, nextRunAt)");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS loop_runs (
        id TEXT PRIMARY KEY, loopId TEXT NOT NULL, workflowId TEXT NOT NULL,
        triggerId TEXT NOT NULL, agentId TEXT NOT NULL,
        status TEXT NOT NULL, triggerOutput TEXT, renderedPrompt TEXT,
        agentConversationId TEXT, loopDir TEXT, error TEXT,
        startedAt TEXT NOT NULL, finishedAt TEXT
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_loop_runs_loop ON loop_runs(loopId, startedAt DESC)",
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_loop_runs_status ON loop_runs(status)");
  }

  private unmarshalLoop(row: LoopRow): Loop {
    return LoopSchema.parse({
      id: row.id,
      ownerId: row.ownerId,
      name: row.name,
      workflowId: row.workflowId,
      enabled: row.enabled === 1,
      tags: JSON.parse(row.tags ?? "[]"),
      lastRunId: row.lastRunId ?? null,
      lastRunAt: row.lastRunAt ?? null,
      nextRunAt: row.nextRunAt ?? null,
      lastError: row.lastError ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private unmarshalRun(row: LoopRunRow): LoopRun {
    return LoopRunSchema.parse({
      id: row.id,
      loopId: row.loopId,
      workflowId: row.workflowId,
      triggerId: row.triggerId,
      agentId: row.agentId,
      status: row.status as LoopRun["status"],
      triggerOutput: row.triggerOutput ?? undefined,
      renderedPrompt: row.renderedPrompt ?? undefined,
      agentConversationId: row.agentConversationId ?? undefined,
      loopDir: row.loopDir ?? undefined,
      error: row.error ?? undefined,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt ?? undefined,
    });
  }

  async create(input: LoopInput): Promise<Loop> {
    const now = new Date().toISOString();
    const l: Loop = LoopSchema.parse({
      ...input,
      enabled: input.enabled ?? false,
      tags: input.tags ?? [],
      lastRunId: null,
      lastRunAt: null,
      nextRunAt: null,
      lastError: null,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
    this.db
      .prepare(
        `INSERT INTO loops (id, ownerId, name, workflowId, enabled, tags, lastRunId, lastRunAt, nextRunAt, lastError, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        l.id,
        l.ownerId,
        l.name,
        l.workflowId,
        l.enabled ? 1 : 0,
        JSON.stringify(l.tags),
        null,
        null,
        null,
        null,
        l.createdAt,
        l.updatedAt,
      );
    return l;
  }

  async get(id: string): Promise<Loop | undefined> {
    const row = this.db.prepare("SELECT * FROM loops WHERE id = ?").get(id) as LoopRow | undefined;
    return row ? this.unmarshalLoop(row) : undefined;
  }

  async listByOwner(ownerId: string): Promise<Loop[]> {
    const rows = this.db
      .prepare("SELECT * FROM loops WHERE ownerId = ? ORDER BY updatedAt DESC")
      .all(ownerId) as LoopRow[];
    return rows.map((r) => this.unmarshalLoop(r));
  }

  async listEnabled(): Promise<Loop[]> {
    const rows = this.db.prepare("SELECT * FROM loops WHERE enabled = 1").all() as LoopRow[];
    return rows.map((r) => this.unmarshalLoop(r));
  }

  async update(id: string, patch: Partial<LoopInput>): Promise<Loop> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`loop 不存在: ${id}`);
    const next: Loop = {
      ...cur,
      ...patch,
      id: cur.id,
      ownerId: cur.ownerId,
      workflowId: cur.workflowId,
      createdAt: cur.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare("UPDATE loops SET name=?, tags=?, updatedAt=? WHERE id=?")
      .run(next.name, JSON.stringify(next.tags), next.updatedAt, next.id);
    return next;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM loops WHERE id = ?").run(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<Loop> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`loop 不存在: ${id}`);
    const updatedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE loops SET enabled=?, updatedAt=? WHERE id=?")
      .run(enabled ? 1 : 0, updatedAt, id);
    return { ...cur, enabled, updatedAt };
  }

  async updateRuntimeState(
    id: string,
    patch: Partial<Pick<Loop, "lastRunId" | "lastRunAt" | "nextRunAt" | "lastError">>,
  ): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k}=?`);
      args.push(v);
    }
    if (!sets.length) return;
    args.push(id);
    this.db.prepare(`UPDATE loops SET ${sets.join(", ")} WHERE id=?`).run(...args);
  }

  async createRun(run: Omit<LoopRun, "finishedAt">): Promise<LoopRun> {
    const r: LoopRun = LoopRunSchema.parse({ ...run, finishedAt: null });
    this.db
      .prepare(
        `INSERT INTO loop_runs (id, loopId, workflowId, triggerId, agentId, status, triggerOutput, renderedPrompt, agentConversationId, loopDir, error, startedAt, finishedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.id,
        r.loopId,
        r.workflowId,
        r.triggerId,
        r.agentId,
        r.status,
        r.triggerOutput ?? null,
        r.renderedPrompt ?? null,
        r.agentConversationId ?? null,
        r.loopDir ?? null,
        r.error ?? null,
        r.startedAt,
        null,
      );
    return r;
  }

  async updateRun(id: string, patch: Partial<LoopRun>): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k}=?`);
      args.push(v);
    }
    if (!sets.length) return;
    args.push(id);
    this.db.prepare(`UPDATE loop_runs SET ${sets.join(", ")} WHERE id=?`).run(...args);
  }

  async getRun(id: string): Promise<LoopRun | undefined> {
    const row = this.db.prepare("SELECT * FROM loop_runs WHERE id = ?").get(id) as
      | LoopRunRow
      | undefined;
    return row ? this.unmarshalRun(row) : undefined;
  }

  async listRuns(loopId: string, opts?: { limit?: number; before?: string }): Promise<LoopRun[]> {
    const limit = opts?.limit ?? 50;
    const sql = opts?.before
      ? "SELECT * FROM loop_runs WHERE loopId = ? AND startedAt < ? ORDER BY startedAt DESC LIMIT ?"
      : "SELECT * FROM loop_runs WHERE loopId = ? ORDER BY startedAt DESC LIMIT ?";
    const rows = (
      opts?.before
        ? this.db.prepare(sql).all(loopId, opts.before, limit)
        : this.db.prepare(sql).all(loopId, limit)
    ) as LoopRunRow[];
    return rows.map((r) => this.unmarshalRun(r));
  }
}
