import { apiFetch } from "./auth";

/**
 * 知识库 API（spec 2026-09-22-knowledge-base-design §7）。
 * _role: "manage"（属主/admin，可维护可分享）| "use"（被分享，只读）。
 */

export interface KbLibraryDTO {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  personal: boolean;
  updatedAt: string;
  /** 列表形态不含 systemPrompt（详情才有） */
  systemPrompt?: string;
  createdAt?: string;
  _mine: boolean;
  _role: "manage" | "use";
}

export interface KbTreeEntryDTO {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
  children?: KbTreeEntryDTO[];
}

export interface KbTreeDTO {
  entries: KbTreeEntryDTO[];
  truncated: boolean;
  total: number;
}

export interface KbRevisionDTO {
  id: string;
  kbId: string;
  path: string;
  action: "create" | "update" | "delete" | "config" | "import" | "library-deleted";
  actorUserId: string;
  actorKind: "manual" | "chat" | "auto-learn" | "memory" | "import" | "system";
  conversationId?: string;
  taskId?: string;
  summary: string;
  beforeHash?: string;
  afterHash?: string;
  diffText?: string;
  createdAt: string;
}

export interface KbShareInfo {
  enabled: boolean;
  token?: string | null;
  url?: string | null;
  grants: Array<{ kbId: string; userId: string; grantedAt: string }>;
}

async function readErrorMessage(r: Response, fallback: string): Promise<string> {
  try {
    const body = (await r.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // 非 JSON 响应
  }
  return fallback;
}

export async function fetchKnowledgeBases(): Promise<KbLibraryDTO[]> {
  const r = await apiFetch("/api/kb");
  if (!r.ok) throw new Error(`kb ${r.status}`);
  return (await r.json()) as KbLibraryDTO[];
}

export async function fetchKb(id: string): Promise<KbLibraryDTO> {
  const r = await apiFetch(`/api/kb/${id}`);
  if (!r.ok) throw new Error(`kb ${r.status}`);
  return (await r.json()) as KbLibraryDTO;
}

export async function createKb(input: {
  name: string;
  description?: string;
  systemPrompt?: string;
}): Promise<KbLibraryDTO> {
  const r = await apiFetch("/api/kb", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(await readErrorMessage(r, `create ${r.status}`));
  return (await r.json()) as KbLibraryDTO;
}

export async function updateKb(
  id: string,
  patch: { name?: string; description?: string; systemPrompt?: string },
): Promise<KbLibraryDTO> {
  const r = await apiFetch(`/api/kb/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(await readErrorMessage(r, `update ${r.status}`));
  return (await r.json()) as KbLibraryDTO;
}

export async function deleteKb(id: string): Promise<void> {
  const r = await apiFetch(`/api/kb/${id}`, { method: "DELETE" });
  if (r.ok || r.status === 204) return;
  throw new Error(await readErrorMessage(r, `delete ${r.status}`));
}

export async function fetchKbTree(id: string): Promise<KbTreeDTO> {
  const r = await apiFetch(`/api/kb/${id}/tree`);
  if (!r.ok) throw new Error(`tree ${r.status}`);
  return (await r.json()) as KbTreeDTO;
}

export async function fetchKbEntry(id: string, path: string): Promise<string> {
  const r = await apiFetch(`/api/kb/${id}/entry?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(`entry ${r.status}`);
  const body = (await r.json()) as { content: string };
  return body.content;
}

export async function fetchKbRevisions(id: string): Promise<KbRevisionDTO[]> {
  const r = await apiFetch(`/api/kb/${id}/revisions`);
  if (!r.ok) throw new Error(`revisions ${r.status}`);
  const body = (await r.json()) as { revisions: KbRevisionDTO[] };
  return body.revisions;
}

export async function fetchKbShare(id: string): Promise<KbShareInfo> {
  const r = await apiFetch(`/api/kb/${id}/share`);
  if (!r.ok) throw new Error(`share ${r.status}`);
  return (await r.json()) as KbShareInfo;
}

export async function setKbShare(id: string, enabled: boolean): Promise<KbShareInfo> {
  const r = await apiFetch(`/api/kb/${id}/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(await readErrorMessage(r, `share ${r.status}`));
  return (await r.json()) as KbShareInfo;
}

export async function removeKbGrant(id: string, grantUserId: string): Promise<void> {
  const r = await apiFetch(`/api/kb/${id}/share/grants/${grantUserId}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`grant ${r.status}`);
}

export async function duplicateKb(id: string): Promise<KbLibraryDTO> {
  const r = await apiFetch(`/api/kb/${id}/duplicate`, { method: "POST" });
  if (!r.ok) throw new Error(await readErrorMessage(r, `duplicate ${r.status}`));
  return (await r.json()) as KbLibraryDTO;
}

/** 探查分享链接（免登录可用；登录态接受走 acceptKbShare） */
export async function fetchKbByShare(
  token: string,
): Promise<{ kbId: string; name: string; description: string }> {
  const r = await apiFetch(`/api/kb/by-share/${token}`);
  if (!r.ok) throw new Error(`by-share ${r.status}`);
  return (await r.json()) as { kbId: string; name: string; description: string };
}

export async function acceptKbShare(
  id: string,
  token: string,
): Promise<{ kbId: string; name: string }> {
  const r = await apiFetch(`/api/kb/${id}/accept-share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!r.ok) throw new Error(await readErrorMessage(r, `accept ${r.status}`));
  return (await r.json()) as { kbId: string; name: string };
}

/** 知识库会话 get-or-create（后端按 kbId 复用最新会话；agentId=builtin-kb-assistant） */
export async function getOrCreateKbConversation(kbId: string): Promise<{ id: string }> {
  const r = await apiFetch(`/api/kb/${kbId}/conversation`);
  if (!r.ok) throw new Error(`kb conv ${r.status}`);
  return (await r.json()) as { id: string };
}
