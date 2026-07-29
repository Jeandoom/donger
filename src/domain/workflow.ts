import { z } from "zod";

export const WorkflowSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  triggerId: z.string(),
  agentId: z.string(),
  promptTemplate: z.string().default("{{triggerOutput}}"),
  outputSubdir: z.string().default("outputs/"),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

export const WorkflowInputSchema = WorkflowSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

/** 把 trigger 抓取到的内容包装成 agent 的 user message。 */
export function renderPromptTemplate(template: string, triggerOutput: string): string {
  return template.replaceAll("{{triggerOutput}}", triggerOutput);
}
