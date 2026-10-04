import { z } from "zod";
import type { Conversation } from "./conversation.js";
import {
  AgentExtensionDirectoriesInputSchema,
  AgentExtensionDirectoriesSchema,
} from "./extension-directory.js";
import { AgentGitRepositoriesSchema } from "./git.js";
import { AgentPermissionModeSchema } from "./permission-mode.js";
import { SCENARIO_KEYS } from "./scenario-preset.js";

export const McpServerConfigSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["stdio", "http"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const AgentToolsSchema = z.object({
  mode: z.enum(["all", "whitelist"]),
  whitelist: z.array(z.string()).default([]),
});
export type AgentTools = z.infer<typeof AgentToolsSchema>;

/** 会话资源范围（% 会话引用）：enabled 关闭时候选为空、resolve 一律丢弃 */
export const AgentConversationScopeSchema = z.object({
  enabled: z.boolean().default(false),
  /** 有权查看的智能体 id 多选；空数组 = 仅本智能体 */
  agentIds: z.array(z.string()).default([]),
  /** 最近 N 天（1-99）；缺省不限天 */
  days: z.number().int().min(1).max(99).optional(),
  /** 最近 N 条（1-99）；缺省 10 */
  limit: z.number().int().min(1).max(99).optional(),
});
export type AgentConversationScope = z.infer<typeof AgentConversationScopeSchema>;

/** effectiveConversationScope 的展开结果（days 缺省 = 不限天） */
export interface EffectiveConversationScope {
  agentIds: string[];
  days?: number;
  limit: number;
}

/** 反馈资源范围（# 反馈引用）：enabled 关闭时候选为空、resolve 一律丢弃 */
export const AgentFeedbackScopeSchema = z.object({
  enabled: z.boolean().default(false),
  /** 最近 N 天（1-99）；缺省不限天。按 updatedAt（回复会 bump，即「最近有活动」） */
  days: z.number().int().min(1).max(99).optional(),
  /** 最近 N 条（1-99）；缺省 10 */
  limit: z.number().int().min(1).max(99).optional(),
});
export type AgentFeedbackScope = z.infer<typeof AgentFeedbackScopeSchema>;

/** effectiveFeedbackScope 的展开结果（days 缺省 = 不限天） */
export interface EffectiveFeedbackScope {
  days?: number;
  limit: number;
}

/**
 * 反馈引用过滤口径（候选下发/单条校验/全部展开三处共用，杜绝口径漂移）。
 * agent 未配置或 enabled=false 时返回 undefined（功能未开启）。
 * 反馈不绑智能体，故无 agentIds 维度；可见性（member 本人 / admin 全量）在调用方按角色分流。
 */
export function effectiveFeedbackScope(
  agent: Pick<Agent, "feedbackScope"> | undefined,
): EffectiveFeedbackScope | undefined {
  const scope = agent?.feedbackScope;
  if (!scope?.enabled) return undefined;
  return {
    ...(scope.days !== undefined ? { days: scope.days } : {}),
    limit: scope.limit ?? 10,
  };
}

/**
 * 会话引用过滤口径（候选下发/单条校验/全部展开三处共用，杜绝口径漂移）。
 * agent 未配置或 enabled=false 时返回 undefined（功能未开启）。
 */
export function effectiveConversationScope(
  agent: Pick<Agent, "conversationScope"> | undefined,
  currentAgentId: string,
): EffectiveConversationScope | undefined {
  const scope = agent?.conversationScope;
  if (!scope?.enabled) return undefined;
  return {
    agentIds: scope.agentIds.length > 0 ? scope.agentIds : [currentAgentId],
    ...(scope.days !== undefined ? { days: scope.days } : {}),
    limit: scope.limit ?? 10,
  };
}

/**
 * 按会话范围过滤：属主（跨用户铁律——共享智能体的使用者也只可能引用到自己的会话）
 * + 绑定智能体在范围内 + 时间窗口，updatedAt 降序取前 limit 条。
 * excludeConversationId 排除当前会话自身（内容已在上下文中，重复注入无意义）。
 */
export function filterConversationsByScope(
  conversations: readonly Conversation[],
  scope: EffectiveConversationScope,
  viewerId: string,
  now = new Date(),
  excludeConversationId?: string,
): Conversation[] {
  const cutoff =
    scope.days !== undefined
      ? new Date(now.getTime() - scope.days * 86_400_000).toISOString()
      : undefined;
  const inScope = new Set(scope.agentIds);
  return conversations
    .filter(
      (c) =>
        c.userId === viewerId &&
        c.agentId.length > 0 &&
        inScope.has(c.agentId) &&
        (cutoff === undefined || c.updatedAt >= cutoff) &&
        c.id !== excludeConversationId,
    )
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, scope.limit);
}

/**
 * 按反馈范围过滤：时间窗口（按 updatedAt——回复会 bump 主项，即「最近有活动」）
 * + updatedAt 降序取前 limit 条。可见性（member 本人 / admin 全量）由调用方选源后传入，
 * 本函数不做属主过滤（store 的 listByUser/listAll 已按 userId 分流）。
 */
export function filterFeedbacksByScope<F extends { updatedAt: string }>(
  feedbacks: readonly F[],
  scope: EffectiveFeedbackScope,
  now = new Date(),
): F[] {
  const cutoff =
    scope.days !== undefined
      ? new Date(now.getTime() - scope.days * 86_400_000).toISOString()
      : undefined;
  return feedbacks
    .filter((f) => cutoff === undefined || f.updatedAt >= cutoff)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, scope.limit);
}

export const AgentSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).default([]),
  defaultSkill: z.string().min(1).optional(),
  tools: AgentToolsSchema,
  mcpServers: z.array(McpServerConfigSchema).default([]),
  /** 勾选的连接器 id（弱引用：连接器模块注册的 HTTP MCP；运行时解析为 mcpServers，重名在保存时硬拦） */
  connectorIds: z.array(z.string()).default([]),
  /** 绑定的知识库 id（弱引用：失效库读时忽略；运行时挂载 kb 工具与提示词注入，spec §8；缺省=未绑定） */
  knowledgeBaseIds: z.array(z.string()).optional(),
  /** 自动学习与记忆（默认关）：对话收尾后 LLM 梳理沉淀进绑定的可写库（spec §9.3） */
  kbAutoLearn: z.boolean().optional(),
  /**
   * 独立知识库（可写目标，单选）：自动学习沉淀收窄到该库；保存时须本人可管理并幂等并入
   * knowledgeBaseIds（specs/2026-10-01-agent-own-kb-picker-design.md §2.2；null=清除，
   * 缺省/null=回退「全部可管理绑定库」的既有语义）
   */
  kbWriteTargetId: z.string().nullable().optional(),
  /** 勾选的凭证模板 code（弱引用：执行时按当前用户解析，未配置的注入 _MISSING 标记） */
  credentials: z.array(z.string()).default([]),
  gitRepositories: AgentGitRepositoriesSchema,
  /**
   * 允许 agent 在 shell 中直接执行 git 命令（默认 false=只准走 donger-git 工具；
   * 开态下 git push 等仍走 deploy 审批门兜底）。
   */
  gitAllowShellGit: z.boolean().default(false),
  extensionDirectories: AgentExtensionDirectoriesSchema,
  /** 所属场景（builder 创建时选定；缺省 = 不做场景校验） */
  scenario: z.enum(SCENARIO_KEYS).optional(),
  /** 会话权限模式默认值：绑定该 agent 的会话未手动覆盖时生效（缺省=变更前问询） */
  defaultPermissionMode: AgentPermissionModeSchema.default("ask_before_change"),
  /** 会话资源范围（% 会话引用的候选与「全部会话」展开都受此过滤；缺省 = 功能未开启） */
  conversationScope: AgentConversationScopeSchema.optional(),
  /** 反馈资源范围（# 反馈引用的候选与「全部反馈」展开都受此过滤；缺省 = 功能未开启） */
  feedbackScope: AgentFeedbackScopeSchema.optional(),
  /** 定义版本：store 在 create 时置 1、每次 update 自增（rollback 也是一次新 update） */
  version: z.number().int().positive().default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Agent = z.infer<typeof AgentSchema>;

/** 版本历史摘要（不含 mcpServers 等敏感/大字段，可安全展示） */
export interface AgentVersionSummary {
  agentId: string;
  version: number;
  name: string;
  description?: string;
  skills: string[];
  createdAt: string;
}

/** 入参用：不带 id/时间戳/版本号（由 store 填充） */
export type AgentInput = Omit<
  Agent,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "version"
  | "gitRepositories"
  | "extensionDirectories"
  | "credentials"
  | "connectorIds"
> & {
  gitRepositories?: Agent["gitRepositories"];
  extensionDirectories?: Agent["extensionDirectories"];
  credentials?: string[];
  connectorIds?: string[];
  version?: number;
};
export const AgentInputSchema = AgentSchema.omit({ id: true, createdAt: true, updatedAt: true })
  // 写入口换严格形态：扩展目录仅相对路径（存储/读取保持容忍，见 extension-directory.ts）
  .extend({ extensionDirectories: AgentExtensionDirectoriesInputSchema });

export function parseAgent(raw: unknown): Agent {
  return AgentSchema.parse(raw);
}
export function parseAgentInput(raw: unknown): AgentInput {
  return AgentInputSchema.parse(raw);
}

/** 将智能体配置的默认 Skill 作为 slash 指令追加到用户输入。 */
export function appendDefaultSkill(prompt: string, defaultSkill?: string): string {
  return defaultSkill ? `${prompt}\n/${defaultSkill}` : prompt;
}

/**
 * 归一化凭证引用：gitRepositories 里声明的 credentialCode 自动并入 agent.credentials（去重）。
 * 保证缺失问询/按访问者注入走同一条链路；无新增时原样返回（引用相等，便于调用方省一次写）。
 */
export function normalizeAgentCredentialRefs(agent: Agent): Agent {
  const codes = new Set(agent.credentials);
  for (const repo of agent.gitRepositories) {
    if (repo.credentialCode) codes.add(repo.credentialCode);
  }
  if (codes.size === agent.credentials.length) return agent;
  return { ...agent, credentials: [...codes] };
}

/**
 * 复制智能体的新名称（specs/2026-09-20-agent-share-tighten-and-duplicate-design.md §3.3）：
 * 自己的 → 原名-副本；他人的 → 副本将落自分主名下，原名已被自己占用时改用 原名-分享人名，
 * 否则沿用原名；仍撞名时追加序号 -2、-3 …（名称无唯一约束，序号只为人眼可分辨）。
 */
export function resolveDuplicateName(
  originName: string,
  isMine: boolean,
  sourceOwnerName: string,
  existingNames: ReadonlySet<string>,
): string {
  let base: string;
  if (isMine) base = `${originName}-副本`;
  else if (existingNames.has(originName)) base = `${originName}-${sourceOwnerName}`;
  else return originName;
  if (!existingNames.has(base)) return base;
  let n = 2;
  while (existingNames.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
