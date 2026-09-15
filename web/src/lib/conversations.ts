import type { AgentPermissionMode, ConversationSummary } from "../types";
import { getToken } from "./auth";

/** 默认会话（未绑定智能体） */
export function isDefaultConv(c: Pick<ConversationSummary, "agentId">): boolean {
  return !c.agentId || c.agentId === "";
}

/** 属于指定智能体的会话 */
export function isAgentConv(c: Pick<ConversationSummary, "agentId">, agentId: string): boolean {
  return c.agentId === agentId;
}

/** 切换会话权限模式（PATCH /api/conversations/:id，仅会话属主） */
export async function setConversationPermissionMode(
  conversationId: string,
  permissionMode: AgentPermissionMode,
): Promise<void> {
  const token = getToken();
  const res = await fetch(`/api/conversations/${conversationId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ permissionMode }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
