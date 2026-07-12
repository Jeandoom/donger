import { apiFetch } from "./auth";

export interface PublicShareInfo {
  agentId: string;
  name: string;
  description?: string;
  requiresLogin: boolean;
}

export interface ShareGrant {
  agentId: string;
  userId: string;
  grantedAt: string;
}

export interface ShareStatus {
  enabled: boolean;
  token: string | null;
  url: string | null;
  grants: ShareGrant[];
}

export interface AcceptShareResult {
  conversation: { id: string; agentId: string };
}

export async function fetchPublicShare(token: string): Promise<PublicShareInfo> {
  const r = await apiFetch(`/api/agents/by-share/${token}`);
  if (!r.ok) throw new Error(`share ${r.status}`);
  return (await r.json()) as PublicShareInfo;
}

export async function acceptShare(agentId: string, token: string): Promise<AcceptShareResult> {
  const r = await apiFetch(`/api/agents/${agentId}/accept-share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!r.ok) throw new Error(`accept ${r.status}`);
  return (await r.json()) as AcceptShareResult;
}

export async function fetchShareStatus(agentId: string): Promise<ShareStatus> {
  const r = await apiFetch(`/api/agents/${agentId}/share`);
  if (!r.ok) throw new Error(`share-status ${r.status}`);
  return (await r.json()) as ShareStatus;
}

export async function setShareEnabled(
  agentId: string,
  enabled: boolean,
): Promise<{ enabled: boolean; token: string | null; url: string | null }> {
  const r = await apiFetch(`/api/agents/${agentId}/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(`set-share ${r.status}`);
  return (await r.json()) as { enabled: boolean; token: string | null; url: string | null };
}

export async function removeShareGrant(agentId: string, userId: string): Promise<void> {
  const r = await apiFetch(`/api/agents/${agentId}/share/grants/${userId}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`remove-grant ${r.status}`);
}
