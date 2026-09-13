import { apiFetch } from "./auth";

export interface McpServerDTO {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface AgentGitRepositoryDTO {
  id: string;
  name: string;
  provider: "github" | "gitee" | "jihulab";
  url: string;
  ref?: string;
  required: boolean;
  shallow: boolean;
  syncMode: "cloneOnce" | "fastForward";
  /** 引用凭证模板 code（私有仓库认证；保存时自动并入 credentials） */
  credentialCode?: string;
  /** 浅克隆历史窗口（git --shallow-since，仅 shallow 时生效） */
  shallowSince?: string;
}

export interface AgentExtensionDirectoryDTO {
  id: string;
  name: string;
  path: string;
  access: "readOnly" | "readWrite";
}

export interface AgentDTO {
  id: string;
  ownerId: string;
  editable?: boolean;
  name: string;
  description?: string;
  systemPrompt?: string;
  skills: string[];
  defaultSkill?: string;
  tools: { mode: "all" | "whitelist"; whitelist: string[] };
  mcpServers: McpServerDTO[];
  /** 勾选的连接器 id（连接器模块注册的 HTTP MCP；保存时后端校验重名） */
  connectorIds?: string[];
  credentials?: string[];
  gitRepositories: AgentGitRepositoryDTO[];
  extensionDirectories: AgentExtensionDirectoryDTO[];
  /** 所属场景：code-dev / kb-qa / research / ops；缺省 = 不做场景校验 */
  scenario?: "code-dev" | "kb-qa" | "research" | "ops";
  /** 允许 shell 直跑 git（默认 false=只准走 donger-git 工具） */
  gitAllowShellGit?: boolean;
  /** 执行完成后弹验收门（人工验收）；requiresDesign=true 的任务恒弹 */
  acceptanceGate?: boolean;
  llm: { presetId?: string };
  createdAt: string;
  updatedAt: string;
}

export interface AgentListDTO extends Omit<AgentDTO, "gitRepositories" | "extensionDirectories"> {
  _mine: boolean;
  gitRepositories?: AgentGitRepositoryDTO[];
  extensionDirectories?: AgentExtensionDirectoryDTO[];
}

export interface AgentMeta {
  skills: { id: string; name: string; description?: string }[];
  tools: string[];
  llmPresets: { id: string; name: string; model: string; baseUrl: string }[];
}

export type AgentInput = Omit<AgentDTO, "id" | "ownerId" | "createdAt" | "updatedAt">;

export async function fetchAgents(): Promise<AgentListDTO[]> {
  const r = await apiFetch("/api/agents");
  if (!r.ok) throw new Error(`agents ${r.status}`);
  return (await r.json()) as AgentListDTO[];
}

export async function fetchAgent(id: string): Promise<AgentDTO> {
  const r = await apiFetch(`/api/agents/${id}`);
  if (!r.ok) throw new Error(`agent ${r.status}`);
  return (await r.json()) as AgentDTO;
}

export async function fetchAgentMeta(): Promise<AgentMeta> {
  const r = await apiFetch("/api/agents/meta/options");
  if (!r.ok) throw new Error(`meta ${r.status}`);
  return (await r.json()) as AgentMeta;
}

/** 场景代码 → 中文短标签（列表卡片展示用） */
export const SCENARIO_LABELS: Record<string, string> = {
  "code-dev": "代码项目",
  "kb-qa": "知识问答",
  research: "调研分析",
  ops: "运维操作",
};

export function scenarioLabel(scenario?: string): string {
  return (scenario && SCENARIO_LABELS[scenario]) || "通用";
}

export type AgentSaveResult = AgentDTO & { warnings?: string[] };

/** 从错误响应体提取可读信息（后端校验错误为 {error: string}） */
async function readErrorMessage(r: Response, fallback: string): Promise<string> {
  try {
    const body = (await r.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // 非 JSON 响应
  }
  return fallback;
}

export async function createAgent(input: AgentInput): Promise<AgentSaveResult> {
  const r = await apiFetch("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(await readErrorMessage(r, `create ${r.status}`));
  return (await r.json()) as AgentSaveResult;
}

export async function updateAgent(id: string, patch: Partial<AgentDTO>): Promise<AgentSaveResult> {
  const r = await apiFetch(`/api/agents/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(await readErrorMessage(r, `update ${r.status}`));
  return (await r.json()) as AgentDTO;
}

export async function deleteAgent(id: string): Promise<void> {
  const r = await apiFetch(`/api/agents/${id}`, { method: "DELETE" });
  if (r.ok || r.status === 204) return;
  throw new Error(await readErrorMessage(r, `delete ${r.status}`));
}

export async function getOrCreateAgentConversation(agentId: string): Promise<{ id: string }> {
  const r = await apiFetch(`/api/agents/${agentId}/conversation`);
  if (!r.ok) throw new Error(`conv ${r.status}`);
  return (await r.json()) as { id: string };
}
