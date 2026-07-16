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
}

export interface AgentDTO {
  id: string;
  ownerId: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  skills: string[];
  tools: { mode: "all" | "whitelist"; whitelist: string[] };
  mcpServers: McpServerDTO[];
  gitRepositories: AgentGitRepositoryDTO[];
  llm: { presetId?: string };
  createdAt: string;
  updatedAt: string;
}

export interface AgentListDTO extends Omit<AgentDTO, "gitRepositories"> {
  _mine: boolean;
  gitRepositories?: AgentGitRepositoryDTO[];
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

export async function createAgent(input: AgentInput): Promise<AgentDTO> {
  const r = await apiFetch("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`create ${r.status}`);
  return (await r.json()) as AgentDTO;
}

export async function updateAgent(id: string, patch: Partial<AgentDTO>): Promise<AgentDTO> {
  const r = await apiFetch(`/api/agents/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`update ${r.status}`);
  return (await r.json()) as AgentDTO;
}

export async function deleteAgent(id: string): Promise<void> {
  const r = await apiFetch(`/api/agents/${id}`, { method: "DELETE" });
  if (!r.ok && r.status !== 204) throw new Error(`delete ${r.status}`);
}

export async function getOrCreateAgentConversation(agentId: string): Promise<{ id: string }> {
  const r = await apiFetch(`/api/agents/${agentId}/conversation`);
  if (!r.ok) throw new Error(`conv ${r.status}`);
  return (await r.json()) as { id: string };
}
