import { z } from "zod";

export const WorkflowSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string().min(1).max(64),
  description: z.string().optional(),
  /** 订阅的事件（原 triggerId；spec 2026-10-09-events-workflows-refactor-design §3.2） */
  eventId: z.string(),
  agentId: z.string(),
  promptTemplate: z.string().default("{{triggerOutput}}"),
  /** 启用态（原 Loop.enabled；loops 模块已移除） */
  enabled: z.boolean().default(false),
  // —— 运行态（原 Loop 运行字段收编）——
  lastRunId: z.string().nullable().optional(),
  lastRunAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

export const WorkflowInputSchema = WorkflowSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  enabled: true,
  lastRunId: true,
  lastRunAt: true,
  lastError: true,
});
// ponytail: z.input 让带 .default() 的字段（promptTemplate）在输入类型里可选
export type WorkflowInput = z.input<typeof WorkflowInputSchema>;

export function parseWorkflowInput(raw: unknown): WorkflowInput {
  return WorkflowInputSchema.parse(raw);
}
