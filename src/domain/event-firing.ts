import { z } from "zod";

/**
 * 触发记录（spec 2026-10-09-events-workflows-refactor-design §3.3）：
 * 事件每 fire 一次落一行（零订阅也记）；永久保留（D5），无按时间清理。
 * 查看面：事件详情「触发记录」列表 → 行点击看 context 全文 + 本次扇出的执行列表。
 */
export const EventFiringSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  ownerId: z.string(),
  /** manual / schedule / call / system */
  source: z.string(),
  /** 事件上下文原文（截断 32KB 后存储；owner-only 可见） */
  context: z.string(),
  /** 本次扇出命中的启用工作流数（含因队列满直接失败者） */
  matchedWorkflowCount: z.number().int().min(0),
  firedAt: z.string(),
});
export type EventFiring = z.infer<typeof EventFiringSchema>;

/** context 入库截断上限：触发记录面向回溯而非完整重放（渲染管线另有 wrapUntrusted 20k 上限） */
export const FIRING_CONTEXT_MAX_BYTES = 32 * 1024;
