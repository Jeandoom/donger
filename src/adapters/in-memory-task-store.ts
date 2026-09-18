import type { Task, TaskStatus } from "../domain/types.js";
import type { TaskStore } from "../ports/task-store.js";

/** 终态集合：终态任务拒绝状态回写（与 SqliteTaskStore 同语义） */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["done", "failed", "canceled"]);

/** TaskStore 的内存实现（M1 纵切用；真实持久化留后续）。 */
export class InMemoryTaskStore implements TaskStore {
  private readonly byId = new Map<string, Task>();

  async create(task: Task): Promise<void> {
    if (this.byId.has(task.id)) throw new Error(`task 已存在: ${task.id}`);
    this.byId.set(task.id, task);
  }

  async get(id: string): Promise<Task | undefined> {
    return this.byId.get(id);
  }

  async getVisible(viewerId: string, id: string): Promise<Task | undefined> {
    const task = this.byId.get(id);
    if (!task || task.requesterId !== viewerId) return undefined;
    return { ...task };
  }

  async listVisible(viewerId: string, status: TaskStatus): Promise<Task[]> {
    return [...this.byId.values()]
      .filter((t) => t.requesterId === viewerId && t.status === status)
      .map((t) => ({ ...t }));
  }

  async updateStatus(id: string, status: TaskStatus, patch: Partial<Task> = {}): Promise<void> {
    const cur = this.byId.get(id);
    if (!cur) throw new Error(`task 不存在: ${id}`);
    // 终态幂等：终态后忽略一切状态回写
    if (TERMINAL_STATUSES.has(cur.status)) return;
    this.byId.set(id, { ...cur, ...patch, status, updatedAt: new Date().toISOString() });
  }

  async listByStatus(status: TaskStatus): Promise<Task[]> {
    return [...this.byId.values()].filter((t) => t.status === status);
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
