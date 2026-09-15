import { z } from "zod";
import { AgentExtensionDirectoriesSchema } from "./extension-directory.js";
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

export const AgentLLMSchema = z.object({ presetId: z.string().optional() });
export type AgentLLM = z.infer<typeof AgentLLMSchema>;

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
  llm: AgentLLMSchema,
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
export const AgentInputSchema = AgentSchema.omit({ id: true, createdAt: true, updatedAt: true });

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
