import type { Database } from "better-sqlite3";
import type { UsageQuery, UsageRecord, UsageStore } from "../ports/usage-store.js";

export class SqliteUsageStore implements UsageStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_creation_input_tokens INTEGER NOT NULL,
        cache_read_input_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        recorded_at TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_records(user_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_task ON usage_records(task_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_records(recorded_at)");
  }

  async record(r: Omit<UsageRecord, "id" | "recordedAt" | "totalTokens">): Promise<UsageRecord> {
    const totalTokens =
      r.inputTokens + r.outputTokens + r.cacheCreationInputTokens + r.cacheReadInputTokens;
    const rec: UsageRecord = {
      ...r,
      id: crypto.randomUUID(),
      totalTokens,
      recordedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO usage_records
         (id, task_id, user_id, channel_id, model, input_tokens, output_tokens,
          cache_creation_input_tokens, cache_read_input_tokens, total_tokens, recorded_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        rec.id,
        rec.taskId,
        rec.userId,
        rec.channelId,
        rec.model,
        rec.inputTokens,
        rec.outputTokens,
        rec.cacheCreationInputTokens,
        rec.cacheReadInputTokens,
        rec.totalTokens,
        rec.recordedAt,
      );
    return rec;
  }

  async listByUser(userId: string, q: Omit<UsageQuery, "userId"> = {}): Promise<UsageRecord[]> {
    return this.list({ ...q, userId });
  }

  async list(q: UsageQuery = {}): Promise<UsageRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.userId) {
      where.push("user_id = ?");
      params.push(q.userId);
    }
    if (q.taskId) {
      where.push("task_id = ?");
      params.push(q.taskId);
    }
    if (q.since) {
      where.push("recorded_at >= ?");
      params.push(q.since);
    }
    if (q.until) {
      where.push("recorded_at <= ?");
      params.push(q.until);
    }
    const limit = Math.min(q.limit ?? 100, 1000);
    params.push(limit);
    const sql = `SELECT * FROM usage_records${
      where.length ? ` WHERE ${where.join(" AND ")}` : ""
    } ORDER BY recorded_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRec(row));
  }

  private rowToRec(row: Record<string, unknown>): UsageRecord {
    return {
      id: row.id as string,
      taskId: row.task_id as string,
      userId: row.user_id as string,
      channelId: row.channel_id as string,
      model: row.model as string,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      cacheCreationInputTokens: row.cache_creation_input_tokens as number,
      cacheReadInputTokens: row.cache_read_input_tokens as number,
      totalTokens: row.total_tokens as number,
      recordedAt: row.recorded_at as string,
    };
  }
}
