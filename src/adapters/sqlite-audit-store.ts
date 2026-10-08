import type { Database } from "better-sqlite3";
import type { AuditEvent } from "../domain/types.js";
import type { AuditConversationSummary, AuditStore } from "../ports/audit-store.js";

/** LIKE 通配符转义（配合 ESCAPE '\'）：%/_/反斜杠按字面匹配 */
function likePattern(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export class SqliteAuditStore implements AuditStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        taskId TEXT NOT NULL,
        userId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        text TEXT,
        llmInput TEXT,
        llmOutput TEXT,
        toolName TEXT,
        toolInput TEXT,
        toolUseId TEXT,
        toolOutput TEXT,
        isError INTEGER,
        resultSubtype TEXT,
        inputTokens INTEGER,
        outputTokens INTEGER,
        cacheCreationInputTokens INTEGER,
        cacheReadInputTokens INTEGER,
        model TEXT,
        durationMs INTEGER,
        recordedAt TEXT NOT NULL
      )
    `);
    this.addColumnIfMissing("audit_events", "llmInput", "TEXT");
    this.addColumnIfMissing("audit_events", "llmOutput", "TEXT");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_audit_conv ON audit_events(conversationId, recordedAt, seq)",
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_events(taskId)");
  }

  private static readonly INSERT_SQL = `INSERT INTO audit_events
         (id, conversationId, taskId, userId, seq, type, text, llmInput, llmOutput, toolName, toolInput, toolUseId,
          toolOutput, isError, resultSubtype, inputTokens, outputTokens, cacheCreationInputTokens,
          cacheReadInputTokens, model, durationMs, recordedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

  async record(e: Omit<AuditEvent, "id"> & { id?: string }): Promise<AuditEvent> {
    const rec: AuditEvent = { ...e, id: e.id ?? crypto.randomUUID() };
    this.insertEvent(rec);
    return rec;
  }

  async recordMany(events: AuditEvent[]): Promise<void> {
    if (events.length === 0) return;
    const stmt = this.db.prepare(SqliteAuditStore.INSERT_SQL);
    // 单事务批量插入：把每事件一次 autocommit 的多轮 fsync 摊薄为一次（WAL 之上的第二层收益）
    this.db.transaction((rows: AuditEvent[]) => {
      for (const rec of rows) this.insertEvent(rec, stmt);
    })(events);
  }

  private insertEvent(rec: AuditEvent, stmt = this.db.prepare(SqliteAuditStore.INSERT_SQL)): void {
    stmt.run(
        rec.id,
        rec.conversationId,
        rec.taskId,
        rec.userId,
        rec.seq,
        rec.type,
        rec.text ?? null,
        rec.llmInput ?? null,
        rec.llmOutput ?? null,
        rec.toolName ?? null,
        rec.toolInput ?? null,
        rec.toolUseId ?? null,
        rec.toolOutput ?? null,
        rec.isError === undefined ? null : rec.isError ? 1 : 0,
        rec.resultSubtype ?? null,
        rec.usage?.inputTokens ?? null,
        rec.usage?.outputTokens ?? null,
        rec.usage?.cacheCreationInputTokens ?? null,
        rec.usage?.cacheReadInputTokens ?? null,
        rec.model ?? null,
        rec.durationMs ?? null,
        rec.recordedAt,
      );
  }

  async backfillToolUseInputs(
    conversationId: string,
    entries: Array<{ toolUseId: string; toolInput: string }>,
  ): Promise<number> {
    // 仅补空壳（'{}'/NULL）：幂等——已有真实入参（如重放重跑）绝不覆盖
    const stmt = this.db.prepare(
      `UPDATE audit_events SET toolInput = ?
       WHERE conversationId = ? AND type = 'tool_use' AND toolUseId = ?
         AND (toolInput = '{}' OR toolInput IS NULL)`,
    );
    let updated = 0;
    for (const e of entries) {
      updated += stmt.run(e.toolInput, conversationId, e.toolUseId).changes;
    }
    return updated;
  }

  async maxSeq(conversationId: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), -1) AS m FROM audit_events WHERE conversationId = ?")
      .get(conversationId) as { m: number };
    return row.m;
  }

  async listByConversationVisible(viewerId: string, conversationId: string): Promise<AuditEvent[]> {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM audit_events a
         JOIN conversations c ON c.id = a.conversationId
         WHERE a.conversationId = ? AND c.userId = ?
         ORDER BY a.recordedAt ASC, a.seq ASC`,
      )
      .all(conversationId, viewerId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToEv(row));
  }

  async listByTaskVisible(viewerId: string, taskId: string): Promise<AuditEvent[]> {
    // 任务属主判定经 tasks 表（requesterId 存于 data JSON）
    const rows = this.db
      .prepare(
        `SELECT a.* FROM audit_events a
         JOIN tasks t ON t.id = a.taskId
         WHERE a.taskId = ? AND json_extract(t.data, '$.requesterId') = ?
         ORDER BY a.recordedAt ASC, a.seq ASC`,
      )
      .all(taskId, viewerId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToEv(row));
  }

  async listConversationSummariesVisible(viewerId: string): Promise<AuditConversationSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT a.conversationId AS conversationId,
                COUNT(DISTINCT a.taskId) AS turnCount,
                COALESCE(SUM(a.inputTokens),0) + COALESCE(SUM(a.outputTokens),0)
                  + COALESCE(SUM(a.cacheCreationInputTokens),0) + COALESCE(SUM(a.cacheReadInputTokens),0) AS totalTokens,
                COALESCE(SUM(CASE WHEN a.type='result' THEN a.durationMs END),0) AS totalDurationMs,
                MIN(a.recordedAt) AS firstAt,
                MAX(a.recordedAt) AS lastAt
         FROM audit_events a
         JOIN conversations c ON c.id = a.conversationId
         WHERE c.userId = ?
         GROUP BY a.conversationId
         ORDER BY lastAt DESC`,
      )
      .all(viewerId) as Record<string, unknown>[];
    return rows.map((r) => ({
      conversationId: r.conversationId as string,
      turnCount: r.turnCount as number,
      totalTokens: r.totalTokens as number,
      totalDurationMs: r.totalDurationMs as number,
      firstAt: r.firstAt as string,
      lastAt: r.lastAt as string,
    }));
  }

  async listByConversation(conversationId: string): Promise<AuditEvent[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM audit_events WHERE conversationId = ? ORDER BY recordedAt ASC, seq ASC",
      )
      .all(conversationId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEv(r));
  }

  async listByTask(taskId: string): Promise<AuditEvent[]> {
    const rows = this.db
      .prepare("SELECT * FROM audit_events WHERE taskId = ? ORDER BY recordedAt ASC, seq ASC")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEv(r));
  }

  async listConversationSummaries(): Promise<AuditConversationSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT conversationId,
                COUNT(DISTINCT taskId) AS turnCount,
                COALESCE(SUM(inputTokens),0) + COALESCE(SUM(outputTokens),0)
                  + COALESCE(SUM(cacheCreationInputTokens),0) + COALESCE(SUM(cacheReadInputTokens),0) AS totalTokens,
                COALESCE(SUM(CASE WHEN type='result' THEN durationMs END),0) AS totalDurationMs,
                MIN(recordedAt) AS firstAt,
                MAX(recordedAt) AS lastAt
         FROM audit_events
         GROUP BY conversationId
         ORDER BY lastAt DESC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      conversationId: r.conversationId as string,
      turnCount: r.turnCount as number,
      totalTokens: r.totalTokens as number,
      totalDurationMs: r.totalDurationMs as number,
      firstAt: r.firstAt as string,
      lastAt: r.lastAt as string,
    }));
  }

  async searchByKeyword(keyword: string, limit: number): Promise<AuditEvent[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_events
         WHERE text LIKE ? ESCAPE '\\'
         ORDER BY recordedAt DESC, seq DESC LIMIT ?`,
      )
      .all(likePattern(keyword), limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEv(r));
  }

  async searchByKeywordVisible(
    viewerId: string,
    keyword: string,
    limit: number,
  ): Promise<AuditEvent[]> {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM audit_events a
         JOIN conversations c ON c.id = a.conversationId
         WHERE c.userId = ? AND a.text LIKE ? ESCAPE '\\'
         ORDER BY a.recordedAt DESC, a.seq DESC LIMIT ?`,
      )
      .all(viewerId, likePattern(keyword), limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEv(r));
  }

  /** kb_search 0 命中统计（R-E）：近 limit 次调用，按 toolUseId 关联 tool_result 判空命中 */
  async kbSearchStats(limit = 500): Promise<{ total: number; zeroHit: number }> {
    const uses = this.db
      .prepare(
        `SELECT toolUseId FROM audit_events
         WHERE type = 'tool_use' AND toolName = 'mcp__donger-kb__kb_search'
         ORDER BY recordedAt DESC LIMIT ?`,
      )
      .all(limit) as Array<{ toolUseId: string | null }>;
    const resultStmt = this.db.prepare(
      `SELECT toolOutput FROM audit_events WHERE type = 'tool_result' AND toolUseId = ?`,
    );
    let total = 0;
    let zeroHit = 0;
    for (const use of uses) {
      if (!use.toolUseId) continue;
      total++;
      const row = resultStmt.get(use.toolUseId) as { toolOutput?: string } | undefined;
      const output = row?.toolOutput ?? "";
      // R-B 结构化空 hits / 旧格式（M2-M5 期间）无命中标记，两种都计
      if (output.includes('"hits":[]') || output.includes("（无命中")) zeroHit++;
    }
    return { total, zeroHit };
  }

  private rowToEv(row: Record<string, unknown>): AuditEvent {
    const usage =
      row.inputTokens !== null && row.outputTokens !== null
        ? {
            inputTokens: row.inputTokens as number,
            outputTokens: row.outputTokens as number,
            cacheCreationInputTokens: (row.cacheCreationInputTokens as number) ?? 0,
            cacheReadInputTokens: (row.cacheReadInputTokens as number) ?? 0,
          }
        : undefined;
    return {
      id: row.id as string,
      conversationId: row.conversationId as string,
      taskId: row.taskId as string,
      userId: row.userId as string,
      seq: row.seq as number,
      type: row.type as AuditEvent["type"],
      text: (row.text as string) ?? undefined,
      llmInput: (row.llmInput as string) ?? undefined,
      llmOutput: (row.llmOutput as string) ?? undefined,
      toolName: (row.toolName as string) ?? undefined,
      toolInput: (row.toolInput as string) ?? undefined,
      toolUseId: (row.toolUseId as string) ?? undefined,
      toolOutput: (row.toolOutput as string) ?? undefined,
      isError: row.isError === null ? undefined : row.isError === 1,
      resultSubtype: (row.resultSubtype as AuditEvent["resultSubtype"]) ?? undefined,
      usage,
      model: (row.model as string) ?? undefined,
      durationMs: (row.durationMs as number) ?? undefined,
      recordedAt: row.recordedAt as string,
    };
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}
