import { z } from "zod";

export const LoopSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string().min(1),
  workflowId: z.string(),
  enabled: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  lastRunId: z.string().nullable().optional(),
  lastRunAt: z.string().nullable().optional(),
  nextRunAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Loop = z.infer<typeof LoopSchema>;

export const LoopInputSchema = LoopSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastRunId: true,
  lastRunAt: true,
  nextRunAt: true,
  lastError: true,
});
// ponytail: z.input 让带 .default() 的字段（enabled/tags）在输入类型里可选，与运行时行为一致
export type LoopInput = z.input<typeof LoopInputSchema>;

export const LoopRunStatusSchema = z.enum(["running", "success", "failed", "stopped"]);
export type LoopRunStatus = z.infer<typeof LoopRunStatusSchema>;

export const LoopRunSchema = z.object({
  id: z.string(),
  loopId: z.string(),
  workflowId: z.string(),
  triggerId: z.string(),
  agentId: z.string(),
  status: LoopRunStatusSchema,
  triggerOutput: z.string().nullable().optional(),
  renderedPrompt: z.string().nullable().optional(),
  agentConversationId: z.string().nullable().optional(),
  loopDir: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  startedAt: z.string(),
  finishedAt: z.string().nullable().optional(),
});
export type LoopRun = z.infer<typeof LoopRunSchema>;

export function parseLoopInput(raw: unknown): LoopInput {
  return LoopInputSchema.parse(raw);
}
