import { apiFetch } from "./auth";

/** 会话可选模型（GET /api/conversations/:id/llm-options） */
export interface LlmOptionDTO {
  ref: string;
  label: string;
  group: "system" | "preset" | "provider";
}

export interface LlmOptionsDTO {
  options: LlmOptionDTO[];
  /** true=智能体配置了模型范围 */
  restricted: boolean;
  /** 会话上次选择的 modelRef（空=未选过） */
  current: string;
}

export async function fetchLlmOptions(conversationId: string): Promise<LlmOptionsDTO> {
  const response = await apiFetch(`/api/conversations/${conversationId}/llm-options`);
  if (!response.ok) throw new Error(`加载可选模型失败：HTTP ${response.status}`);
  return (await response.json()) as LlmOptionsDTO;
}

export interface LlmPlatformInfo {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  custom: boolean;
  sdkType: "anthropic" | "openai";
  note?: string;
}

export interface LlmProvider {
  id: string;
  userId: string;
  name: string;
  platform: string;
  baseUrl: string;
  models: string[];
  sdkType: "anthropic" | "openai";
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LlmProvidersResponse {
  providers: LlmProvider[];
  systemDefaultModel: string;
  systemPresets: { id: string; name: string; model: string }[];
}

export interface LlmProviderInput {
  name: string;
  platform: string;
  baseUrl?: string;
  key?: string;
  models: string[];
  sdkType?: "anthropic" | "openai";
  isDefault?: boolean;
}

export type LlmTestResult =
  | { ok: true; model: string }
  | { ok: false; kind: "network" | "auth" | "protocol" | "bad_request"; message: string };

export async function fetchLlmPlatforms(): Promise<LlmPlatformInfo[]> {
  const response = await apiFetch("/api/settings/llm-platforms");
  if (!response.ok) throw new Error(`加载平台列表失败：HTTP ${response.status}`);
  const body = (await response.json()) as { platforms: LlmPlatformInfo[] };
  return body.platforms;
}

export async function fetchLlmProviders(): Promise<LlmProvidersResponse> {
  const response = await apiFetch("/api/settings/llm-providers");
  if (!response.ok) throw new Error(`加载模型配置失败：HTTP ${response.status}`);
  return (await response.json()) as LlmProvidersResponse;
}

async function parseError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return new Error(body.error);
  } catch {
    // 使用默认错误信息
  }
  return new Error(`${fallback}：HTTP ${response.status}`);
}

export async function createLlmProvider(input: LlmProviderInput): Promise<LlmProvider> {
  const response = await apiFetch("/api/settings/llm-providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await parseError(response, "新建模型配置失败");
  return (await response.json()) as LlmProvider;
}

export async function updateLlmProvider(id: string, input: LlmProviderInput): Promise<LlmProvider> {
  const response = await apiFetch(`/api/settings/llm-providers/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await parseError(response, "保存模型配置失败");
  return (await response.json()) as LlmProvider;
}

export async function deleteLlmProvider(id: string): Promise<void> {
  const response = await apiFetch(`/api/settings/llm-providers/${id}`, { method: "DELETE" });
  if (!response.ok) throw await parseError(response, "删除模型配置失败");
}

export async function testLlmProvider(id: string): Promise<LlmTestResult> {
  const response = await apiFetch(`/api/settings/llm-providers/${id}/test`, { method: "POST" });
  if (!response.ok) throw await parseError(response, "测试连接失败");
  return (await response.json()) as LlmTestResult;
}
