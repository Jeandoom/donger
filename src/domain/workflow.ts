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

/**
 * 通知策略（spec 2026-10-20-feedback-notify-loop §M2）：工作流的一等配置块——run 终态
 * 后由平台通知执行器派生一条 notify 轮（写手 agent 产出通知文案）并按通道投递。
 * 字段缺省/整个字段不填 = 不通知（现状行为）。
 */
export const NotifyPolicySchema = z.object({
  enabled: z.boolean().default(true),
  /** 触发终态；缺省仅成功 */
  on: z
    .array(z.enum(["success", "failed", "stopped"]))
    .min(1)
    .default(["success"]),
  /** 通知文案写手智能体；缺省=工作流绑定的 agent */
  writerAgentId: z.string().min(1).optional(),
  /** 写手指令模板（{{statusWord}}/{{outputSummary}}/{{feedbackId}} 等简报变量可用）；空=平台默认模板 */
  promptTemplate: z.string().max(4000).optional(),
  /** 通知标题；空=「工作流「{name}」结果通知」 */
  title: z.string().max(120).optional(),
  /** 投递通道白名单；站外仍受用户偏好订阅与地址绑定约束（M3 值域全量） */
  channels: z
    .array(z.enum(["inapp", "dingtalk", "webhook", "email", "source"]))
    .min(1)
    .default(["inapp"]),
  /** 收件人：correlation=事件因果提交人；owner=工作流属主；显式 userId 列表 */
  recipients: z
    .union([z.literal("correlation"), z.literal("owner"), z.array(z.string().min(1)).min(1)])
    .default("correlation"),
});
export type NotifyPolicy = z.infer<typeof NotifyPolicySchema>;

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
  /** 通知策略（2026-10-20 反馈闭环 M2）：缺省不通知 */
  notifyPolicy: NotifyPolicySchema.optional(),
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
