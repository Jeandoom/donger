import type { Database } from "better-sqlite3";
import type { Task, TaskStatus } from "../domain/types.js";
import type { TaskStore } from "../ports/task-store.js";

/** 终态集合：终态任务拒绝状态回写（并发/重启窗口下防旧上下文覆盖结局，幂等保护） */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["done", "failed", "canceled"]);

/** SQLite 持久化的 TaskStore（重启不丢）。 */
export class SqliteTaskStore implements TaskStore {
  constructor(private readonly db: Database) {}

  /** 建表 + 索引（幂等，启动时调一次）。 */
  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        status TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)");
  }

  async create(task: Task): Promise<void> {
    this.db
      .prepare("INSERT INTO tasks (id, data, status, updatedAt) VALUES (?, ?, ?, ?)")
      .run(task.id, JSON.stringify(task), task.status, task.updatedAt);
  }

  async get(id: string): Promise<Task | undefined> {
    const row = this.db.prepare("SELECT data FROM tasks WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Task) : undefined;
  }

  async updateStatus(id: string, status: TaskStatus, patch: Partial<Task> = {}): Promise<void> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`task 不存在: ${id}`);
    // 终态幂等：done/failed/canceled 后忽略一切状态回写（含同态重复写）
    if (TERMINAL_STATUSES.has(cur.status)) return;
    const updated: Task = { ...cur, ...patch, status, updatedAt: new Date().toISOString() };
    this.db
      .prepare("UPDATE tasks SET data = ?, status = ?, updatedAt = ? WHERE id = ?")
      .run(JSON.stringify(updated), status, updated.updatedAt, id);
  }

  async listByStatus(status: TaskStatus): Promise<Task[]> {
    const rows = this.db
      .prepare("SELECT data FROM tasks WHERE status = ? ORDER BY updatedAt DESC")
      .all(status) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Task);
  }

  async failStaleRunning(reason: string): Promise<number> {
    const stale = await this.listByStatus("running");
    for (const t of stale) {
      await this.updateStatus(t.id, "failed", { error: reason });
    }
    return stale.length;
  }

  async failStaleAwaiting(reason: string): Promise<number> {
    const stale = [
      ...(await this.listByStatus("awaiting_approval")),
      ...(await this.listByStatus("awaiting_credentials")),
    ];
    for (const t of stale) {
      await this.updateStatus(t.id, "failed", {
        error: reason,
        pendingGate: undefined,
        pendingCredentials: undefined,
      });
    }
    return stale.length;
  }
}
