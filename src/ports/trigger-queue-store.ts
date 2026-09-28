export type TriggerQueueStatus = "pending" | "running" | "done" | "dropped";

export interface TriggerQueueRow {
  id: string;
  loopId: string;
  /** 溯源用：发出该事件的 trigger（手动运行为空串） */
  triggerId: string;
  /** 溯源用：事件名 / hook 路径 / "scheduler" / "manual" */
  eventName: string;
  payload: string;
  status: TriggerQueueStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TriggerQueueEnqueueInput {
  loopId: string;
  triggerId: string;
  eventName: string;
  payload: string;
}

/**
 * 触发事件持久化队列（spec 2026-09-28-event-trigger-feedback-design §5.1）。
 * 交付层语义：fire=入队+泵抽；行状态只记交付结果（done/dropped），
 * 运行成败由 loop_runs 承载——队列不做重试，防永久失败 loop 被无限重投。
 */
export interface TriggerQueueStore {
  migrate(): void;
  /** 入队；单 loop pending 达 maxPending 时新行直接落 dropped（不执行，调用方负责告警） */
  enqueue(input: TriggerQueueEnqueueInput, maxPending: number): Promise<TriggerQueueRow>;
  /** 事务内取最旧 pending→running；单 loop 至多一条 running（泵单线程抽取） */
  claimNextPending(loopId: string): Promise<TriggerQueueRow | undefined>;
  markDone(id: string): Promise<void>;
  countPending(loopId: string): Promise<number>;
  /** 重启恢复：遗留 running→pending（at-least-once 重投），返回重置行数 */
  resetStaleRunning(): number;
  /** 有 pending 行的 loopId 列表（恢复泵用） */
  listLoopIdsWithPending(): Promise<string[]>;
  deleteByLoop(loopId: string): Promise<void>;
  /** 清理终态行（done/dropped），返回清除行数 */
  cleanupFinishedBefore(cutoffIso: string): number;
}
