import { apiFetch } from "./auth";

export type GitProvider = "github" | "gitee" | "jihulab";

export interface GitAccessRequirementDTO {
  provider: GitProvider;
  reason: "access_denied" | "repository_not_found" | "provider_unavailable";
  repositories: Array<{ id: string; name: string; fingerprint: string }>;
}

export interface GitPreflightDTO {
  ready: boolean;
  code?: "GIT_AUTH_REQUIRED";
  requirements: GitAccessRequirementDTO[];
}

export async function fetchGitPreflight(conversationId: string): Promise<GitPreflightDTO> {
  const response = await apiFetch(`/api/conversations/${conversationId}/preflight`);
  if (!response.ok) throw new Error(`Git 权限检查失败：HTTP ${response.status}`);
  return (await response.json()) as GitPreflightDTO;
}
