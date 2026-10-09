import type { WorkflowRun, WorkflowRunStats } from "../domain/workflow-run.js";

/**
 * 工作流执行记录存储：执行事实 + 全局事件队列二合一（spec §3.4/D6）。
 * 队列语义：status=queued 为待执行行；claim 取「最旧 queued 且所属 workflow 无 running 行」
 * （同工作流串行、跨工作流并行）；重启恢复 running→queued 重投（at-least-once）；
 * 记录永久保留（D5），无按时间清理。
 */
export interface WorkflowRunStore {
  migrate(): void;
  insert(run: WorkflowRun): Promise<WorkflowRun>;
  updateRun(id: string, patch: Partial<WorkflowRun>): Promise<void>;
  getRun(id: string): Promise<WorkflowRun | undefined>;
  /** 按 workflow 倒序列出（可按状态过滤、游标分页） */
  listRuns(
    workflowId: string,
    opts?: { limit?: number; before?: string; status?: WorkflowRun["status"] },
  ): Promise<WorkflowRun[]>;
  /** 触发记录详情用：一次事件触发扇出的全部执行 */
  listByFiring(firingId: string): Promise<WorkflowRun[]>;
  /** 全局队列当前 pending 行数（容量判定用，D6） */
  countQueued(): Promise<number>;
  /**
   * 事务内认领：最旧 queued 且其 workflowId 无 running 行 → 置 running 并返回；
   * 无可认领行返回 undefined。
   */
  claimNextRunnable(): Promise<WorkflowRun | undefined>;
  /** 启动恢复：遗留 running → queued（同 run 行重投），返回重置行数 */
  resetStaleRunning(): Promise<number>;
  /** 后端真聚合（执行记录统计卡） */
  stats(workflowId: string): Promise<WorkflowRunStats>;
  deleteByWorkflow(workflowId: string): Promise<void>;
}
