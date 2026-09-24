import { z } from "zod";

// name 会拼进运行目录路径（loop-runner join(workspaceRoot, name, runId)）：
// 禁路径分隔符、.. 与首尾点空格，防 mkdirSync 落到工作区之外
const isSafeWorkflowName = (v: string): boolean =>
  v.length >= 1 &&
  v.length <= 64 &&
  !/[\\/:*?"<>|]/.test(v) &&
  !v.includes("..") &&
  !/^[\s.]/.test(v) &&
  !/[\s.]$/.test(v);

export const WorkflowSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string().refine(isSafeWorkflowName, "name 不可包含路径分隔符、.. 或首尾点空格（≤64 字）"),
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
// ponytail: z.input 让带 .default() 的字段（promptTemplate/outputSubdir）在输入类型里可选
export type WorkflowInput = z.input<typeof WorkflowInputSchema>;

export function parseWorkflowInput(raw: unknown): WorkflowInput {
  return WorkflowInputSchema.parse(raw);
}

/** 把 trigger 抓取到的内容包装成 agent 的 user message。 */
export function renderPromptTemplate(template: string, triggerOutput: string): string {
  return template.replaceAll("{{triggerOutput}}", triggerOutput);
}
