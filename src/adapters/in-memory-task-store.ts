import type { Task, TaskStatus } from "../domain/types.js";
import type { TaskStore } from "../ports/task-store.js";

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

  async updateStatus(id: string, status: TaskStatus, patch: Partial<Task> = {}): Promise<void> {
    const cur = this.byId.get(id);
    if (!cur) throw new Error(`task 不存在: ${id}`);
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
}
