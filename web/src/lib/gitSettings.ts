import { apiFetch } from "./auth";

export type GitProvider = "github" | "gitee" | "jihulab";

export interface GitConnectionDTO {
  id: string;
  provider: GitProvider;
  accountId: string;
  accountName: string;
  avatarUrl?: string;
  authType: "oauth" | "githubApp" | "pat";
  scopes: string[];
  expiresAt?: string;
  status: "active" | "expired" | "revoked";
  updatedAt: string;
}

export interface GitAccessRequirementDTO {
  provider: GitProvider;
  reason:
    | "connection_missing"
    | "token_expired"
    | "token_revoked"
    | "grant_missing"
    | "access_denied"
    | "repository_not_found"
    | "provider_unavailable";
  repositories: Array<{ id: string; name: string; fingerprint: string }>;
}

export interface GitPreflightDTO {
  ready: boolean;
  code?: "GIT_AUTH_REQUIRED";
  requirements: GitAccessRequirementDTO[];
}

export async function fetchGitConnections(): Promise<{
  connections: GitConnectionDTO[];
  oauthConfigured: Record<GitProvider, boolean>;
}> {
  const response = await apiFetch("/api/settings/git/connections");
  if (!response.ok) throw new Error(`加载 Git 配置失败：HTTP ${response.status}`);
  return (await response.json()) as {
    connections: GitConnectionDTO[];
    oauthConfigured: Record<GitProvider, boolean>;
  };
}

export async function saveGitPat(provider: GitProvider, token: string): Promise<void> {
  const response = await apiFetch(`/api/settings/git/${provider}/pat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error(`Git 授权失败：HTTP ${response.status}`);
}

export async function startGitOAuth(provider: GitProvider, returnTo: string): Promise<void> {
  const response = await apiFetch(`/api/settings/git/${provider}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ returnTo }),
  });
  if (!response.ok) throw new Error(`OAuth 启动失败：HTTP ${response.status}`);
  const body = (await response.json()) as { authorizeUrl: string };
  window.location.assign(body.authorizeUrl);
}

export async function deleteGitConnection(id: string): Promise<void> {
  const response = await apiFetch(`/api/settings/git/connections/${id}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`解除 Git 连接失败：HTTP ${response.status}`);
}

export async function fetchGitPreflight(conversationId: string): Promise<GitPreflightDTO> {
  const response = await apiFetch(`/api/conversations/${conversationId}/preflight`);
  if (!response.ok) throw new Error(`Git 权限检查失败：HTTP ${response.status}`);
  return (await response.json()) as GitPreflightDTO;
}

export async function grantGitRepositories(
  conversationId: string,
  repositoryIds: string[],
): Promise<GitPreflightDTO> {
  const response = await apiFetch(`/api/conversations/${conversationId}/git-grants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryIds }),
  });
  if (!response.ok) throw new Error(`仓库授权失败：HTTP ${response.status}`);
  return (await response.json()) as GitPreflightDTO;
}
