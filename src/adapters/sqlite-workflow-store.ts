import type { Database } from "better-sqlite3";
import type { Workflow, WorkflowInput } from "../domain/workflow.js";
import { WorkflowSchema } from "../domain/workflow.js";
import type { WorkflowStore } from "../ports/workflow-store.js";
import { NotFoundError } from "../util/errors.js";

interface WorkflowRow {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  eventId: string;
  agentId: string;
  promptTemplate: string;
  enabled: number;
  lastRunId: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export class SqliteWorkflowStore implements WorkflowStore {
  constructor(private readonly db: Database) {}

  /**
   * 迁移：建表 + 存量库扩列吸收 Loop（spec §9.2）——eventId=triggerId 回填、
   * enabled 取名下 loops 之或、运行态取最新 loop；订阅了已不存在事件（git 触发器已被
   * event-store 迁移删除，或本就悬空）的 workflow 置 enabled=0。
   * 不在此处 DROP loops：run-store 迁移还需要 loopId→workflowId 映射，由它收尾删除。
   * 调用顺序约束：须后于 event-store 迁移、先于 run-store 迁移。
   */
  migrate(): void {
    const legacy = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflows'")
      .get();
    const cols = legacy
      ? (this.db.prepare("PRAGMA table_info(workflows)").all() as Array<{ name: string }>)
      : [];
    const isLegacy = legacy && !cols.some((c) => c.name === "eventId");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
        eventId TEXT NOT NULL DEFAULT '', agentId TEXT NOT NULL,
        promptTemplate TEXT NOT NULL DEFAULT '{{triggerOutput}}',
        enabled INTEGER NOT NULL DEFAULT 0,
        lastRunId TEXT, lastRunAt TEXT, lastError TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )
    `);
    if (isLegacy) {
      // 旧表补列（CREATE TABLE IF NOT EXISTS 不会改既有表结构）
      this.db.exec("ALTER TABLE workflows ADD COLUMN eventId TEXT NOT NULL DEFAULT ''");
      this.db.exec("ALTER TABLE workflows ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0");
      this.db.exec("ALTER TABLE workflows ADD COLUMN lastRunId TEXT");
      this.db.exec("ALTER TABLE workflows ADD COLUMN lastRunAt TEXT");
      this.db.exec("ALTER TABLE workflows ADD COLUMN lastError TEXT");
      this.db.exec("UPDATE workflows SET eventId = triggerId");
      this.db.exec("ALTER TABLE workflows DROP COLUMN outputSubdir");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_workflows_owner ON workflows(ownerId)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_workflows_event ON workflows(eventId)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_workflows_agent ON workflows(agentId)");

    if (!isLegacy) return;
    // 吸收 Loop：启用态取或；运行态取 lastRunAt 最新的 loop
    const hasLoops = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='loops'")
      .get();
    if (hasLoops) {
      this.db.exec(
        "UPDATE workflows SET enabled = 1 WHERE id IN (SELECT workflowId FROM loops WHERE enabled = 1)",
      );
      this.db.exec(`
        UPDATE workflows SET
          lastRunId = (SELECT l.lastRunId FROM loops l WHERE l.workflowId = workflows.id AND l.lastRunId IS NOT NULL ORDER BY l.lastRunAt DESC LIMIT 1),
          lastRunAt = (SELECT l.lastRunAt FROM loops l WHERE l.workflowId = workflows.id AND l.lastRunAt IS NOT NULL ORDER BY l.lastRunAt DESC LIMIT 1),
          lastError = (SELECT l.lastError FROM loops l WHERE l.workflowId = workflows.id AND l.lastError IS NOT NULL ORDER BY l.lastRunAt DESC LIMIT 1)
      `);
    }
    // 悬空订阅（git 触发器已删/本就不存在）→ 停用，等用户在编辑页改订阅
    this.db.exec(
      "UPDATE workflows SET enabled = 0 WHERE eventId <> '' AND eventId NOT IN (SELECT id FROM events)",
    );
  }

  private unmarshal(row: WorkflowRow): Workflow {
    return WorkflowSchema.parse({
      id: row.id,
      ownerId: row.ownerId,
      name: row.name,
      description: row.description ?? undefined,
      eventId: row.eventId,
      agentId: row.agentId,
      promptTemplate: row.promptTemplate,
      enabled: row.enabled === 1,
      lastRunId: row.lastRunId,
      lastRunAt: row.lastRunAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  async create(input: WorkflowInput): Promise<Workflow> {
    const now = new Date().toISOString();
    const w: Workflow = WorkflowSchema.parse({
      ...input,
      promptTemplate: input.promptTemplate ?? "{{triggerOutput}}",
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
    this.db
      .prepare(
        `INSERT INTO workflows (id, ownerId, name, description, eventId, agentId, promptTemplate, enabled, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        w.id,
        w.ownerId,
        w.name,
        w.description ?? null,
        w.eventId,
        w.agentId,
        w.promptTemplate,
        w.enabled ? 1 : 0,
        w.createdAt,
        w.updatedAt,
      );
    return w;
  }

  async get(id: string): Promise<Workflow | undefined> {
    const row = this.db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as
      | WorkflowRow
      | undefined;
    return row ? this.unmarshal(row) : undefined;
  }

  async listByOwner(ownerId: string): Promise<Workflow[]> {
    const rows = this.db
      .prepare("SELECT * FROM workflows WHERE ownerId = ? ORDER BY updatedAt DESC")
      .all(ownerId) as WorkflowRow[];
    return rows.map((r) => this.unmarshal(r));
  }

  async listAll(): Promise<Workflow[]> {
    const rows = this.db.prepare("SELECT * FROM workflows").all() as WorkflowRow[];
    return rows.map((r) => this.unmarshal(r));
  }

  async update(id: string, patch: Partial<WorkflowInput>): Promise<Workflow> {
    const cur = await this.get(id);
    if (!cur) throw new NotFoundError("WORKFLOW_NOT_FOUND", `workflow 不存在: ${id}`);
    const next: Workflow = {
      ...cur,
      ...patch,
      id: cur.id,
      ownerId: cur.ownerId,
      createdAt: cur.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE workflows SET name=?, description=?, eventId=?, agentId=?, promptTemplate=?, updatedAt=? WHERE id=?`,
      )
      .run(
        next.name,
        next.description ?? null,
        next.eventId,
        next.agentId,
        next.promptTemplate,
        next.updatedAt,
        next.id,
      );
    return next;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<Workflow> {
    const cur = await this.get(id);
    if (!cur) throw new NotFoundError("WORKFLOW_NOT_FOUND", `workflow 不存在: ${id}`);
    this.db
      .prepare("UPDATE workflows SET enabled=?, updatedAt=? WHERE id=?")
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    return { ...cur, enabled };
  }

  async updateRuntimeState(
    id: string,
    patch: Partial<Pick<Workflow, "lastRunId" | "lastRunAt" | "lastError">>,
  ): Promise<void> {
    this.db
      .prepare(
        "UPDATE workflows SET lastRunId=COALESCE(?, lastRunId), lastRunAt=COALESCE(?, lastRunAt), lastError=COALESCE(?, lastError) WHERE id=?",
      )
      .run(patch.lastRunId ?? null, patch.lastRunAt ?? null, patch.lastError ?? null, id);
  }

  async listEnabledByEvent(eventId: string): Promise<Workflow[]> {
    const rows = this.db
      .prepare("SELECT * FROM workflows WHERE eventId = ? AND enabled = 1")
      .all(eventId) as WorkflowRow[];
    return rows.map((r) => this.unmarshal(r));
  }

  async countEnabledByEvent(): Promise<Map<string, number>> {
    const rows = this.db
      .prepare("SELECT eventId, COUNT(*) AS n FROM workflows WHERE enabled = 1 GROUP BY eventId")
      .all() as Array<{ eventId: string; n: number }>;
    return new Map(rows.map((r) => [r.eventId, r.n]));
  }

  async countByAgentId(agentId: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM workflows WHERE agentId = ?")
      .get(agentId) as { n: number };
    return row.n;
  }

  async countByEventId(eventId: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM workflows WHERE eventId = ?")
      .get(eventId) as { n: number };
    return row.n;
  }
}
