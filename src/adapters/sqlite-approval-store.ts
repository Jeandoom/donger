import type { Database } from "better-sqlite3";
import type {
  ApprovalDecisionRecord,
  ApprovalRequestRow,
  ApprovalStore,
} from "../ports/approval-store.js";

/**
 * 审批决议落库（sqlite 实现，热发布 M3）。
 * 幂等决议靠单条 UPDATE 的 WHERE status='pending' 条件：并发/双击下只有一个调用方
 * 拿到 changes=1，其余 409——不依赖应用层锁。
 */
export class SqliteApprovalStore implements ApprovalStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        gate_id TEXT NOT NULL,
        tool TEXT,
        title TEXT NOT NULL,
        summary TEXT,
        payload TEXT,
        channel TEXT NOT NULL DEFAULT 'web',
        status TEXT NOT NULL DEFAULT 'pending',
        decision TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT
      )
    `);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(task_id)`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status)`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_approval_requests_conv ON approval_requests(conversation_id)`,
    );
  }

  async create(row: ApprovalRequestRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO approval_requests
           (id, task_id, conversation_id, gate_id, tool, title, summary, payload, channel, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.taskId,
        row.conversationId,
        row.gateId,
        row.tool ?? null,
        row.title,
        row.summary ?? null,
        row.payload ?? null,
        row.channel,
        row.status,
        row.createdAt,
      );
  }

  async get(id: string): Promise<ApprovalRequestRow | undefined> {
    const row = this.db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToRow(row) : undefined;
  }

  async decide(
    id: string,
    status: "approved" | "rejected",
    decision: ApprovalDecisionRecord,
    decidedAt: string,
  ): Promise<boolean> {
    const r = this.db
      .prepare(
        `UPDATE approval_requests
           SET status = ?, decision = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, JSON.stringify(decision), decidedAt, id);
    return r.changes > 0;
  }

  async listPendingByConversation(conversationId: string): Promise<ApprovalRequestRow[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM approval_requests
          WHERE conversation_id = ? AND status = 'pending'
          ORDER BY created_at ASC`,
      )
      .all(conversationId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToRow(r));
  }

  async cancelByConversation(conversationId: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE approval_requests
           SET status = 'canceled', decided_at = ?
         WHERE conversation_id = ? AND status = 'pending'`,
      )
      .run(new Date().toISOString(), conversationId);
  }

  private rowToRow(r: Record<string, unknown>): ApprovalRequestRow {
    return {
      id: String(r.id),
      taskId: String(r.task_id),
      conversationId: String(r.conversation_id),
      gateId: String(r.gate_id),
      ...(r.tool != null ? { tool: String(r.tool) } : {}),
      title: String(r.title),
      ...(r.summary != null ? { summary: String(r.summary) } : {}),
      ...(r.payload != null ? { payload: String(r.payload) } : {}),
      channel: String(r.channel ?? "web"),
      status: String(r.status ?? "pending") as ApprovalRequestRow["status"],
      ...(r.decision != null ? { decision: String(r.decision) } : {}),
      createdAt: String(r.created_at),
      ...(r.decided_at != null ? { decidedAt: String(r.decided_at) } : {}),
    };
  }
}
