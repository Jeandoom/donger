import type { AgentPermissionMode } from "../types";
import { getToken } from "./auth";

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
