import type { Database } from "better-sqlite3";
import type { AutoDevConfig, NotifyPolicy, Workflow, WorkflowInput } from "../domain/workflow.js";
import { AutoDevConfigSchema, NotifyPolicySchema, WorkflowSchema } from "../domain/workflow.js";
import type { WorkflowStore } from "../ports/workflow-store.js";
import { NotFoundError } from "../util/errors.js";

interface WorkflowRow {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  eventId: string;
  agentId: string;
  permissionMode: string | null;
  promptTemplate: string;
  enabled: number;
  autoDev: string | null;
  notifyPolicy: string | null;
  dedup: string | null;
  lastRunId: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** autoDev JSON 列解析：非法/半截 JSON 一律降级 undefined（不阻断读取） */
function parseAutoDev(raw: string | null): AutoDevConfig | undefined {
  if (!raw) return undefined;
  try {
    const parsed = AutoDevConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** notifyPolicy JSON 列解析：同 autoDev 降级语义 */
function parseNotifyPolicy(raw: string | null): NotifyPolicy | undefined {
  if (!raw) return undefined;
  try {
    const parsed = NotifyPolicySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** dedup JSON 列解析：同 autoDev 降级语义 */
function parseDedup(raw: string | null): { enabled: boolean } | undefined {
  if (!raw) return undefined;
  try {
    const j = JSON.parse(raw) as { enabled?: boolean };
    return typeof j.enabled === "boolean" ? { enabled: j.enabled } : undefined;
  } catch {
    return undefined;
  }
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
        permissionMode TEXT NOT NULL DEFAULT 'full_access',
        enabled INTEGER NOT NULL DEFAULT 0,
        autoDev TEXT,
        notifyPolicy TEXT,
        dedup TEXT,
        lastRunId TEXT, lastRunAt TEXT, lastError TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )
    `);
    // permissionMode 列（2026-10-14 拍板）：无人值守轮以工作流配置为准，缺省完全权限。
    // 存量库按「列是否存在」幂等补列，旧行落缺省 full_access。
    const hasPermissionMode = (
      this.db.prepare("PRAGMA table_info(workflows)").all() as Array<{ name: string }>
    ).some((c) => c.name === "permissionMode");
    if (!hasPermissionMode) {
      this.db.exec(
        "ALTER TABLE workflows ADD COLUMN permissionMode TEXT NOT NULL DEFAULT 'full_access'",
      );
    }
    // autoDev 列（L2 轮）：JSON 文本，按列存在性幂等补列
    const hasAutoDev = (
      this.db.prepare("PRAGMA table_info(workflows)").all() as Array<{ name: string }>
    ).some((c) => c.name === "autoDev");
    if (!hasAutoDev) {
      this.db.exec("ALTER TABLE workflows ADD COLUMN autoDev TEXT");
    }
    // notifyPolicy 列（2026-10-20 反馈闭环 M2）：JSON 文本，幂等补列
    const hasNotifyPolicy = (
      this.db.prepare("PRAGMA table_info(workflows)").all() as Array<{ name: string }>
    ).some((c) => c.name === "notifyPolicy");
    if (!hasNotifyPolicy) {
      this.db.exec("ALTER TABLE workflows ADD COLUMN notifyPolicy TEXT");
    }
    // dedup 列（2026-10-30-workflow-dedup-design）：JSON 文本，幂等补列
    const hasDedup = (
      this.db.prepare("PRAGMA table_info(workflows)").all() as Array<{ name: string }>
    ).some((c) => c.name === "dedup");
    if (!hasDedup) {
      this.db.exec("ALTER TABLE workflows ADD COLUMN dedup TEXT");
    }
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
    // 旧表遗留的 triggerId 列（NOT NULL 无默认）若仍在表上，新 INSERT（列清单不含它）
    // 会撞 NOT NULL 约束。上一版迁移只加列未删列，半迁移存量库 eventId 已在、进不了
    // legacy 分支——故按「列是否存在」幂等摘除，新旧两态都覆盖。
    const hasTriggerId = (
      this.db.prepare("PRAGMA table_info(workflows)").all() as Array<{ name: string }>
    ).some((c) => c.name === "triggerId");
    if (hasTriggerId) {
      // DROP COLUMN 对被索引的列会报错，先摘旧 trigger 索引
      this.db.exec("DROP INDEX IF EXISTS idx_workflows_trigger");
      this.db.exec("ALTER TABLE workflows DROP COLUMN triggerId");
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
      permissionMode: row.permissionMode ?? undefined,
      promptTemplate: row.promptTemplate,
      enabled: row.enabled === 1,
      autoDev: parseAutoDev(row.autoDev),
      notifyPolicy: parseNotifyPolicy(row.notifyPolicy),
      dedup: parseDedup(row.dedup),
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
        `INSERT INTO workflows (id, ownerId, name, description, eventId, agentId, permissionMode, promptTemplate, enabled, autoDev, notifyPolicy, dedup, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        w.id,
        w.ownerId,
        w.name,
        w.description ?? null,
        w.eventId,
        w.agentId,
        w.permissionMode,
        w.promptTemplate,
        w.enabled ? 1 : 0,
        w.autoDev ? JSON.stringify(w.autoDev) : null,
        w.notifyPolicy ? JSON.stringify(w.notifyPolicy) : null,
        w.dedup ? JSON.stringify(w.dedup) : null,
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
    // schema.parse 归一：patch 里 z.input 形态的半省略字段（如 autoDev.policy）合并后
    // 补齐缺省，避免 input/output 形态混写进库
    const next: Workflow = WorkflowSchema.parse({
      ...cur,
      ...patch,
      id: cur.id,
      ownerId: cur.ownerId,
      createdAt: cur.createdAt,
      updatedAt: new Date().toISOString(),
    });
    this.db
      .prepare(
        `UPDATE workflows SET name=?, description=?, eventId=?, agentId=?, permissionMode=?, promptTemplate=?, enabled=?, autoDev=?, notifyPolicy=?, dedup=?, updatedAt=? WHERE id=?`,
      )
      .run(
        next.name,
        next.description ?? null,
        next.eventId,
        next.agentId,
        next.permissionMode,
        next.promptTemplate,
        next.enabled ? 1 : 0,
        next.autoDev ? JSON.stringify(next.autoDev) : null,
        next.notifyPolicy ? JSON.stringify(next.notifyPolicy) : null,
        next.dedup ? JSON.stringify(next.dedup) : null,
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
