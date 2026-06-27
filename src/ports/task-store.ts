import type { Task, TaskStatus } from "../domain/types.js";

/** 任务持久化端口 */
export interface TaskStore {
  create(task: Task): Promise<void>;
  get(id: string): Promise<Task | undefined>;
  updateStatus(id: string, status: TaskStatus, patch?: Partial<Task>): Promise<void>;
  listByStatus(status: TaskStatus): Promise<Task[]>;
}
