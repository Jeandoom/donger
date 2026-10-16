import { z } from "zod";
import { AgentPermissionModeSchema } from "./permission-mode.js";
import { ReleasePolicySchema } from "./release-policy.js";

/** autoDev 配置（spec 2026-10-16-feedback-auto-dev-deploy-l2-design §5）：
 * 启用后 ReleaseService 轮询该 workflow 绑定 agent 首仓库的 [autofix] MR，
 * 按 policy 纯函数评估自动合并；policy 缺省=推荐值（≤15 文件/≤400 行/日 3 单/冷却 24h） */
export const AutoDevConfigSchema = z.object({
  enabled: z.boolean().default(false),
  policy: ReleasePolicySchema.partial().default({}),
});
export type AutoDevConfig = z.infer<typeof AutoDevConfigSchema>;

export const WorkflowSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string().min(1).max(64),
  description: z.string().optional(),
  /** 订阅的事件（原 triggerId；spec 2026-10-09-events-workflows-refactor-design §3.2） */
  eventId: z.string(),
  agentId: z.string(),
  /** 无人值守轮的会话权限模式（2026-10-14 拍板）：以工作流配置为准，缺省完全权限 */
  permissionMode: AgentPermissionModeSchema.default("full_access"),
  promptTemplate: z.string().default("{{triggerOutput}}"),
  /** 启用态（原 Loop.enabled；loops 模块已移除） */
  enabled: z.boolean().default(false),
  /** 自动发布配置（L2）：缺省关闭 */
  autoDev: AutoDevConfigSchema.optional(),
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
