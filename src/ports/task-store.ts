import type { Task, TaskStatus } from "../domain/types.js";

/** 任务持久化端口 */
export interface TaskStore {
  create(task: Task): Promise<void>;
  get(id: string): Promise<Task | undefined>;
  updateStatus(id: string, status: TaskStatus, patch?: Partial<Task>): Promise<void>;
  listByStatus(status: TaskStatus): Promise<Task[]>;
  /** 服务启动时清理：把遗留 running 任务标记为中断（僵尸清扫，防止污染运行视图） */
  failStaleRunning(reason: string): Promise<number>;
  /** 服务启动时清理：挂起在审批门/凭证门的任务随进程失去 resolve 通道，重启后必然无法恢复 → 标记失败 */
  failStaleAwaiting(reason: string): Promise<number>;
}
