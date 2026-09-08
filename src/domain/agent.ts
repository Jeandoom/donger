import { z } from "zod";
import { AgentExtensionDirectoriesSchema } from "./extension-directory.js";
import { AgentGitRepositoriesSchema } from "./git.js";

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
  gitRepositories: AgentGitRepositoriesSchema,
  extensionDirectories: AgentExtensionDirectoriesSchema,
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
  "id" | "createdAt" | "updatedAt" | "version" | "gitRepositories" | "extensionDirectories"
> & {
  gitRepositories?: Agent["gitRepositories"];
  extensionDirectories?: Agent["extensionDirectories"];
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
