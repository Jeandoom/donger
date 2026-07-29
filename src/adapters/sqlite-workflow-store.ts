import type { Database } from "better-sqlite3";
import type { Workflow, WorkflowInput } from "../domain/workflow.js";
import { WorkflowSchema } from "../domain/workflow.js";
import type { WorkflowStore } from "../ports/workflow-store.js";

interface WorkflowRow {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  triggerId: string;
  agentId: string;
  promptTemplate: string;
  outputSubdir: string;
  createdAt: string;
  updatedAt: string;
}

export class SqliteWorkflowStore implements WorkflowStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
        triggerId TEXT NOT NULL, agentId TEXT NOT NULL,
        promptTemplate TEXT NOT NULL, outputSubdir TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_workflows_owner ON workflows(ownerId)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_workflows_trigger ON workflows(triggerId)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_workflows_agent ON workflows(agentId)");
  }

  private unmarshal(row: WorkflowRow): Workflow {
    return WorkflowSchema.parse({
      id: row.id,
      ownerId: row.ownerId,
      name: row.name,
      description: row.description ?? undefined,
      triggerId: row.triggerId,
      agentId: row.agentId,
      promptTemplate: row.promptTemplate,
      outputSubdir: row.outputSubdir,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  async create(input: WorkflowInput): Promise<Workflow> {
    const now = new Date().toISOString();
    const w: Workflow = WorkflowSchema.parse({
      ...input,
      promptTemplate: input.promptTemplate ?? "{{triggerOutput}}",
      outputSubdir: input.outputSubdir ?? "outputs/",
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
    this.db
      .prepare(
        `INSERT INTO workflows (id, ownerId, name, description, triggerId, agentId, promptTemplate, outputSubdir, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        w.id,
        w.ownerId,
        w.name,
        w.description ?? null,
        w.triggerId,
        w.agentId,
        w.promptTemplate,
        w.outputSubdir,
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

  async update(id: string, patch: Partial<WorkflowInput>): Promise<Workflow> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`workflow 不存在: ${id}`);
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
        `UPDATE workflows SET name=?, description=?, triggerId=?, agentId=?, promptTemplate=?, outputSubdir=?, updatedAt=? WHERE id=?`,
      )
      .run(
        next.name,
        next.description ?? null,
        next.triggerId,
        next.agentId,
        next.promptTemplate,
        next.outputSubdir,
        next.updatedAt,
        next.id,
      );
    return next;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
  }
}
