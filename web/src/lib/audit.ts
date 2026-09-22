// 审计页数据获取 + 纯显示函数（fetch 逻辑 + 格式化；UI 在 AuditPage）。
// 后端契约见 docs/superpowers/specs/2026-07-01-conversation-audit-design.md §6。

import { apiFetch } from "./auth";

export interface AuditEventDTO {
  id: string;
  type:
    | "user_message"
    | "session_init"
    | "llm_input"
    | "llm_output"
    | "text"
    | "tool_use"
    | "tool_result"
    | "result";
  text?: string;
  llmInput?: string;
  llmOutput?: string;
  toolName?: string;
  toolInput?: string;
  toolUseId?: string;
  toolOutput?: string;
  isError?: boolean;
  resultSubtype?: "success" | "error";
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  model?: string;
  durationMs?: number;
  seq: number;
  recordedAt: string;
}

export interface AuditConversationListItem {
  conversationId: string;
  title: string;
  userId: string;
  channelId: string;
  turnCount: number;
  totalTokens: number;
  totalDurationMs: number;
  firstAt: string;
  lastAt: string;
  createdAt: string;
}

export interface AuditTurn {
  taskId: string;
  prompt: string;
  status: string;
  createdAt: string;
  durationMs?: number;
  usage?: AuditEventDTO["usage"];
  events: AuditEventDTO[];
}

export interface AuditDetail {
  conversation: { id: string; title: string; userId: string; channelId: string } | null;
  turns: AuditTurn[];
}

export async function fetchAuditConversations(): Promise<AuditConversationListItem[]> {
  const res = await apiFetch("/api/audit/conversations");
  if (!res.ok) throw new Error(`audit conversations ${res.status}`);
  return (await res.json()) as AuditConversationListItem[];
}

export async function fetchAuditDetail(id: string): Promise<AuditDetail> {
  const res = await apiFetch(`/api/audit/conversations/${id}`);
  if (!res.ok) throw new Error(`audit detail ${res.status}`);
  return (await res.json()) as AuditDetail;
}

export async function debugLlmInput(
  input: string,
  presetId?: string,
): Promise<{ output: string; model: string }> {
  const res = await apiFetch("/api/llm/debug", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, presetId }),
  });
  if (!res.ok) throw new Error(`llm debug ${res.status}`);
  return (await res.json()) as { output: string; model: string };
}

/** 毫秒 → 人类可读；undefined → '—'。 */
export function formatDurationMs(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n < 1000) return `${n}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  const m = Math.floor(n / 60000);
  const s = Math.round((n % 60000) / 1000);
  return `${m}m ${s}s`;
}

/** token 数 → 紧凑表达；undefined → '—'。 */
export function formatTokens(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

/** ISO 时间 → 本地可读；无效值原样返回。 */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// ---------------------------------------------------------------------------
// 知识库修订审计（spec 2026-09-22-knowledge-base-design §10.4）
// ---------------------------------------------------------------------------

export interface KbRevisionAuditDTO {
  id: string;
  kbId: string;
  path: string;
  action: "create" | "update" | "delete" | "config" | "import" | "library-deleted";
  actorUserId: string;
  actorKind: "manual" | "chat" | "auto-learn" | "memory" | "import" | "system";
  conversationId?: string;
  summary: string;
  diffText?: string;
  createdAt: string;
}

export interface KbAuditResponse {
  revisions: KbRevisionAuditDTO[];
  /** kbId → 库名；已删除库不在映射中（前端显示「已删除库」） */
  kbNames: Record<string, string>;
}

export async function fetchKbAuditRevisions(): Promise<KbAuditResponse> {
  const r = await apiFetch("/api/audit/kb-revisions");
  if (!r.ok) throw new Error(`kb-revisions ${r.status}`);
  return (await r.json()) as KbAuditResponse;
}
