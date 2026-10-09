import type { Database } from "better-sqlite3";
import type { WorkflowRun, WorkflowRunStats, WorkflowRunStatus } from "../domain/workflow-run.js";
import { WorkflowRunSchema } from "../domain/workflow-run.js";
import type { WorkflowRunStore } from "../ports/workflow-run-store.js";

interface WorkflowRunRow {
  id: string;
  workflowId: string;
  eventId: string;
  firingId: string | null;
  eventName: string;
  status: string;
  context: string | null;
  renderedPrompt: string | null;
  conversationId: string | null;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export class SqliteWorkflowRunStore implements WorkflowRunStore {
  constructor(private readonly db: Database) {}

  /**
   * 迁移（spec §9.3/9.4，调用顺序约束：最后执行，负责收尾 DROP loops/trigger_queue）：
   * 1. loop_runs → workflow_runs 建表搬运（agentId/loopDir/loopId 退役；running 孤儿行
   *    按 launcher 既有 sweepOrphanedRuns 语义置 failed）；
   * 2. trigger_queue pending/running 行 → queued 执行记录（守住 at-least-once，D6 前身
   *    队列的承诺），done/dropped 终态行不迁；随后 DROP 两张旧表。
   */
  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY, workflowId TEXT NOT NULL, eventId TEXT NOT NULL DEFAULT '',
        firingId TEXT, eventName TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'queued',
        context TEXT, renderedPrompt TEXT, conversationId TEXT, error TEXT,
        queuedAt TEXT NOT NULL, startedAt TEXT, finishedAt TEXT
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_workflow_runs_wf ON workflow_runs(workflowId, queuedAt DESC)",
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_runs_firing ON workflow_runs(firingId)");

    const hasLegacyRuns = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='loop_runs'")
      .get();
    if (hasLegacyRuns) {
      // ponytail: exec 不支持绑定参数，空 startedAt 以空串落库后由下方 UPDATE 兜底回填
      this.db.exec(`
        INSERT OR IGNORE INTO workflow_runs (id, workflowId, eventId, firingId, eventName, status, context, renderedPrompt, conversationId, error, queuedAt, startedAt, finishedAt)
        SELECT id, workflowId, COALESCE(triggerId,''), NULL, 'legacy',
               CASE WHEN status='running' THEN 'failed' ELSE status END,
               triggerOutput, renderedPrompt, agentConversationId,
               CASE WHEN status='running' THEN '进程重启，执行中断（迁移）' ELSE error END,
               COALESCE(startedAt, ''), startedAt, finishedAt
        FROM loop_runs
      `);
      this.db
        .prepare("UPDATE workflow_runs SET queuedAt=? WHERE eventName='legacy' AND queuedAt=''")
        .run(new Date().toISOString());
      this.db.exec("DROP TABLE loop_runs");
    }

    const hasLegacyQueue = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='trigger_queue'")
      .get();
    if (hasLegacyQueue) {
      // loopId→workflowId 映射（loops 表可能不存在=全新库，直接跳过）
      const hasLoops = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='loops'")
        .get();
      if (hasLoops) {
        this.db.exec(`
          INSERT INTO workflow_runs (id, workflowId, eventId, firingId, eventName, status, context, renderedPrompt, conversationId, error, queuedAt, startedAt, finishedAt)
          SELECT lower(hex(randomblob(16))), l.workflowId, '', NULL, q.eventName,
                 'queued', q.payload, NULL, NULL, NULL, q.createdAt, NULL, NULL
          FROM trigger_queue q JOIN loops l ON l.id = q.loopId
          WHERE q.status IN ('pending', 'running')
        `);
      }
      this.db.exec("DROP TABLE trigger_queue");
    }
    if (hasLegacyRuns || hasLegacyQueue) {
      this.db.exec("DROP TABLE IF EXISTS loops");
    }
  }

  private unmarshal(row: WorkflowRunRow): WorkflowRun {
    return WorkflowRunSchema.parse({
      id: row.id,
      workflowId: row.workflowId,
      eventId: row.eventId,
      firingId: row.firingId,
      eventName: row.eventName,
      status: row.status,
      context: row.context,
      renderedPrompt: row.renderedPrompt,
      conversationId: row.conversationId,
      error: row.error,
      queuedAt: row.queuedAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    });
  }

  async insert(run: WorkflowRun): Promise<WorkflowRun> {
    const r = WorkflowRunSchema.parse(run);
    this.db
      .prepare(
        `INSERT INTO workflow_runs (id, workflowId, eventId, firingId, eventName, status, context, renderedPrompt, conversationId, error, queuedAt, startedAt, finishedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.id,
        r.workflowId,
        r.eventId,
        r.firingId ?? null,
        r.eventName,
        r.status,
        r.context ?? null,
        r.renderedPrompt ?? null,
        r.conversationId ?? null,
        r.error ?? null,
        r.queuedAt,
        r.startedAt ?? null,
        r.finishedAt ?? null,
      );
    return r;
  }

  async updateRun(id: string, patch: Partial<WorkflowRun>): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k}=?`);
      args.push(v ?? null);
    }
    if (!sets.length) return;
    args.push(id);
    this.db.prepare(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE id=?`).run(...args);
  }

  async getRun(id: string): Promise<WorkflowRun | undefined> {
    const row = this.db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id) as
      | WorkflowRunRow
      | undefined;
    return row ? this.unmarshal(row) : undefined;
  }

  async listRuns(
    workflowId: string,
    opts?: { limit?: number; before?: string; status?: WorkflowRunStatus },
  ): Promise<WorkflowRun[]> {
    const limit = opts?.limit ?? 50;
    const clauses = ["workflowId = ?"];
    const args: unknown[] = [workflowId];
    if (opts?.before) {
      clauses.push("queuedAt < ?");
      args.push(opts.before);
    }
    if (opts?.status) {
      clauses.push("status = ?");
      args.push(opts.status);
    }
    args.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_runs WHERE ${clauses.join(" AND ")} ORDER BY queuedAt DESC LIMIT ?`,
      )
      .all(...args) as WorkflowRunRow[];
    return rows.map((r) => this.unmarshal(r));
  }

  async listByFiring(firingId: string): Promise<WorkflowRun[]> {
    const rows = this.db
      .prepare("SELECT * FROM workflow_runs WHERE firingId = ? ORDER BY queuedAt ASC")
      .all(firingId) as WorkflowRunRow[];
    return rows.map((r) => this.unmarshal(r));
  }

  async countQueued(): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM workflow_runs WHERE status = 'queued'")
      .get() as { n: number };
    return row.n;
  }

  async claimNextRunnable(): Promise<WorkflowRun | undefined> {
    const claim = this.db.transaction((): WorkflowRun | undefined => {
      const row = this.db
        .prepare(
          `SELECT * FROM workflow_runs
           WHERE status = 'queued'
             AND workflowId NOT IN (SELECT DISTINCT workflowId FROM workflow_runs WHERE status = 'running')
           ORDER BY queuedAt ASC LIMIT 1`,
        )
        .get() as WorkflowRunRow | undefined;
      if (!row) return undefined;
      const result = this.db
        .prepare(
          "UPDATE workflow_runs SET status='running', startedAt=? WHERE id=? AND status='queued'",
        )
        .run(new Date().toISOString(), row.id);
      if (result.changes === 0) return undefined;
      return this.unmarshal({ ...row, status: "running", startedAt: new Date().toISOString() });
    });
    return claim();
  }

  async resetStaleRunning(): Promise<number> {
    const result = this.db
      .prepare("UPDATE workflow_runs SET status='queued', startedAt=NULL WHERE status='running'")
      .run();
    return result.changes;
  }

  async stats(workflowId: string): Promise<WorkflowRunStats> {
    const rows = this.db
      .prepare(
        "SELECT status, COUNT(*) AS n FROM workflow_runs WHERE workflowId = ? GROUP BY status",
      )
      .all(workflowId) as Array<{ status: string; n: number }>;
    const byStatus = new Map(rows.map((r) => [r.status, r.n]));
    const get = (s: string) => byStatus.get(s) ?? 0;
    const total = rows.reduce((acc, r) => acc + r.n, 0);
    const avgRow = this.db
      .prepare(
        `SELECT AVG((julianday(finishedAt) - julianday(startedAt)) * 86400000.0) AS avgMs
         FROM workflow_runs WHERE workflowId = ? AND status='success' AND finishedAt IS NOT NULL AND startedAt IS NOT NULL`,
      )
      .get(workflowId) as { avgMs: number | null };
    return {
      total,
      queued: get("queued"),
      running: get("running"),
      success: get("success"),
      failed: get("failed"),
      stopped: get("stopped"),
      avgDurationMs: avgRow.avgMs === null ? null : Math.round(avgRow.avgMs),
    };
  }

  async deleteByWorkflow(workflowId: string): Promise<void> {
    this.db.prepare("DELETE FROM workflow_runs WHERE workflowId = ?").run(workflowId);
  }
}
