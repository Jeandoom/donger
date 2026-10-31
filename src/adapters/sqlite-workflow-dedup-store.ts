import type { Database } from "better-sqlite3";
import type {
  WorkflowDedupClaimResult,
  WorkflowDedupEntry,
  WorkflowDedupStore,
} from "../ports/workflow-dedup-store.js";

/** 处理登记（幂等键）持久化（spec 2026-10-30-workflow-dedup-design.md §4.1）。
 * claim 用 INSERT OR IGNORE 保证 (workflowId, dedupKey) 原子认领；released 行可重认领（覆盖）。 */
export class SqliteWorkflowDedupStore implements WorkflowDedupStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_dedup_keys (
        workflowId TEXT NOT NULL,
        dedupKey   TEXT NOT NULL,
        runId      TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'claimed',
        note       TEXT,
        createdAt  TEXT NOT NULL,
        updatedAt  TEXT NOT NULL,
        PRIMARY KEY (workflowId, dedupKey)
      )
    `);
  }

  async claim(
    workflowId: string,
    dedupKey: string,
    runId: string,
    note?: string,
  ): Promise<WorkflowDedupClaimResult> {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO workflow_dedup_keys (workflowId, dedupKey, runId, status, note, createdAt, updatedAt)
         VALUES (?, ?, ?, 'claimed', ?, ?, ?)
         ON CONFLICT(workflowId, dedupKey) DO UPDATE SET
           runId = excluded.runId,
           status = 'claimed',
           note = excluded.note,
           updatedAt = excluded.updatedAt
         WHERE workflow_dedup_keys.status = 'released'`,
      )
      .run(workflowId, dedupKey, runId, note ?? null, now, now);
    if (result.changes > 0) return { claimed: true };
    return { claimed: false, existing: await this.get(workflowId, dedupKey) };
  }

  async get(workflowId: string, dedupKey: string): Promise<WorkflowDedupEntry | undefined> {
    const row = this.db
      .prepare("SELECT * FROM workflow_dedup_keys WHERE workflowId = ? AND dedupKey = ?")
      .get(workflowId, dedupKey) as DedupRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  async release(workflowId: string, dedupKey: string, note?: string): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE workflow_dedup_keys
         SET status = 'released', note = COALESCE(?, note), updatedAt = ?
         WHERE workflowId = ? AND dedupKey = ? AND status = 'claimed'`,
      )
      .run(note ?? null, new Date().toISOString(), workflowId, dedupKey);
    return result.changes > 0;
  }

  async list(workflowId: string, opts?: { limit?: number }): Promise<WorkflowDedupEntry[]> {
    const limit = Math.min(opts?.limit ?? 100, 500);
    const rows = this.db
      .prepare(
        "SELECT * FROM workflow_dedup_keys WHERE workflowId = ? ORDER BY createdAt DESC LIMIT ?",
      )
      .all(workflowId, limit) as DedupRow[];
    return rows.map(rowToEntry);
  }
}

interface DedupRow {
  workflowId: string;
  dedupKey: string;
  runId: string;
  status: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToEntry(r: DedupRow): WorkflowDedupEntry {
  return {
    workflowId: r.workflowId,
    dedupKey: r.dedupKey,
    runId: r.runId,
    status: r.status === "released" ? "released" : "claimed",
    note: r.note,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
