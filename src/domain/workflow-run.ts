import { z } from "zod";

/**
 * 工作流执行记录（原 loop_runs 升级 + 吞并 trigger_queue，spec
 * 2026-10-09-events-workflows-refactor-design §3.4）：一次执行一行；
 * 队列语义承载在 status=queued 上（全局单队列，容量 10，D6）。
 * 记录永久保留（D5），无按时间清理。
 */
export const WorkflowRunStatusSchema = z.enum([
  "queued",
  "running",
  "success",
  "failed",
  "stopped",
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

export const WorkflowRunSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  eventId: z.string(),
  /** 来源事件的一次触发（EventFiring.id）；手动运行可为空 */
  firingId: z.string().nullable().optional(),
  /** 触发来源：manual / schedule / call / system:<事件名> */
  eventName: z.string(),
  status: WorkflowRunStatusSchema,
  /** 事件上下文原文（matcher 判定对象 + {{triggerOutput}} 变量） */
  context: z.string().nullable().optional(),
  renderedPrompt: z.string().nullable().optional(),
  /** 本次执行的独立运行会话（执行记录点开跳转 D4） */
  conversationId: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  queuedAt: z.string(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

/** 后端真聚合（执行记录统计卡；替换旧「前端对 50 条算数」） */
export interface WorkflowRunStats {
  total: number;
  queued: number;
  running: number;
  success: number;
  failed: number;
  stopped: number;
  /** 成功轮平均耗时 ms（无成功轮为 null） */
  avgDurationMs: number | null;
}
