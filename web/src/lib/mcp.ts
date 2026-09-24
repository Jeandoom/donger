import { apiFetch } from "./auth";

/** MCP 接入令牌（前端视图；明文只在创建响应中出现一次） */
export interface McpTokenRecord {
  id: string;
  userId: string;
  name: string;
  tokenHint: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface McpConfigView {
  tokens: McpTokenRecord[];
  /** null = 服务端未启用 MCP 端点 */
  endpoint: string | null;
}

export interface McpTokenCreated {
  token: string;
  record: McpTokenRecord;
  endpoint: string;
}

export async function fetchMcpConfig(): Promise<McpConfigView> {
  const res = await apiFetch("/api/mcp/tokens");
  if (!res.ok) throw new Error(`加载 MCP 配置失败：HTTP ${res.status}`);
  return (await res.json()) as McpConfigView;
}

/** expiresInDays：1-3650 整数天数；null = 无限期 */
export async function createMcpToken(
  name: string,
  expiresInDays: number | null,
): Promise<McpTokenCreated> {
  const res = await apiFetch("/api/mcp/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, expiresInDays }),
  });
  const data = (await res.json().catch(() => ({}))) as McpTokenCreated & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `创建失败（HTTP ${res.status}）`);
  return data;
}

export async function revokeMcpToken(id: string): Promise<void> {
  const res = await apiFetch(`/api/mcp/tokens/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `吊销失败（HTTP ${res.status}）`);
  }
}
