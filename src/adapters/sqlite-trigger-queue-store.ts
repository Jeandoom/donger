import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type {
  TriggerQueueEnqueueInput,
  TriggerQueueRow,
  TriggerQueueStore,
} from "../ports/trigger-queue-store.js";

interface QueueRowRecord {
  id: string;
  loopId: string;
  triggerId: string;
  eventName: string;
  payload: string;
  status: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function toRow(r: QueueRowRecord): TriggerQueueRow {
  return {
    id: r.id,
    loopId: r.loopId,
    triggerId: r.triggerId,
    eventName: r.eventName,
    payload: r.payload,
    status: r.status as TriggerQueueRow["status"],
    error: r.error,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

export class SqliteTriggerQueueStore implements TriggerQueueStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trigger_queue (
        id TEXT PRIMARY KEY, loopId TEXT NOT NULL, triggerId TEXT NOT NULL,
        eventName TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
        error TEXT, createdAt TEXT NOT NULL, startedAt TEXT, finishedAt TEXT
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_trigger_queue_loop ON trigger_queue(loopId, status, createdAt)",
    );
  }

  async enqueue(input: TriggerQueueEnqueueInput, maxPending: number): Promise<TriggerQueueRow> {
    const now = new Date().toISOString();
    const pending = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM trigger_queue WHERE loopId = ? AND status = 'pending'")
        .get(input.loopId) as { n: number }
    ).n;
    const overflow = pending >= maxPending;
    const row: QueueRowRecord = {
      id: randomUUID(),
      loopId: input.loopId,
      triggerId: input.triggerId,
      eventName: input.eventName,
      payload: input.payload,
      status: overflow ? "dropped" : "pending",
      error: overflow ? `queue overflow (pending >= ${maxPending})` : null,
      createdAt: now,
      startedAt: null,
      finishedAt: overflow ? now : null,
    };
    this.db
      .prepare(
        `INSERT INTO trigger_queue
         (id, loopId, triggerId, eventName, payload, status, error, createdAt, startedAt, finishedAt)
         VALUES (@id, @loopId, @triggerId, @eventName, @payload, @status, @error, @createdAt, @startedAt, @finishedAt)`,
      )
      .run(row);
    return toRow(row);
  }

  async claimNextPending(loopId: string): Promise<TriggerQueueRow | undefined> {
    const claim = this.db.transaction((): TriggerQueueRow | undefined => {
      const row = this.db
        .prepare(
          "SELECT * FROM trigger_queue WHERE loopId = ? AND status = 'pending' ORDER BY createdAt ASC, id ASC LIMIT 1",
        )
        .get(loopId) as QueueRowRecord | undefined;
      if (!row) return undefined;
      const startedAt = new Date().toISOString();
      this.db
        .prepare("UPDATE trigger_queue SET status = 'running', startedAt = ? WHERE id = ?")
        .run(startedAt, row.id);
      return toRow({ ...row, status: "running", startedAt });
    });
    return claim();
  }

  async markDone(id: string): Promise<void> {
    this.db
      .prepare("UPDATE trigger_queue SET status = 'done', finishedAt = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  async countPending(loopId: string): Promise<number> {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM trigger_queue WHERE loopId = ? AND status = 'pending'")
        .get(loopId) as { n: number }
    ).n;
  }

  resetStaleRunning(): number {
    return this.db
      .prepare(
        "UPDATE trigger_queue SET status = 'pending', startedAt = NULL WHERE status = 'running'",
      )
      .run().changes;
  }

  async listLoopIdsWithPending(): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT DISTINCT loopId FROM trigger_queue WHERE status = 'pending'")
      .all() as Array<{ loopId: string }>;
    return rows.map((r) => r.loopId);
  }

  async deleteByLoop(loopId: string): Promise<void> {
    this.db.prepare("DELETE FROM trigger_queue WHERE loopId = ?").run(loopId);
  }

  cleanupFinishedBefore(cutoffIso: string): number {
    return this.db
      .prepare(
        "DELETE FROM trigger_queue WHERE status IN ('done', 'dropped') AND finishedAt IS NOT NULL AND finishedAt < ?",
      )
      .run(cutoffIso).changes;
  }
}
