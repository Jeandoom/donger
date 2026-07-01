// 审计页数据获取 + 纯显示函数（fetch 逻辑 + 格式化；UI 在 AuditPage）。
// 后端契约见 docs/superpowers/specs/2026-07-01-conversation-audit-design.md §6。

export interface AuditEventDTO {
  id: string;
  type: "user_message" | "session_init" | "text" | "tool_use" | "tool_result" | "result";
  text?: string;
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
  const res = await fetch("/api/audit/conversations");
  return (await res.json()) as AuditConversationListItem[];
}

export async function fetchAuditDetail(id: string): Promise<AuditDetail> {
  const res = await fetch(`/api/audit/conversations/${id}`);
  if (!res.ok) throw new Error(`audit detail ${res.status}`);
  return (await res.json()) as AuditDetail;
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
