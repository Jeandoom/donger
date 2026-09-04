// CLI 类型定义（手写复制，与后端契约一致；同 web/src/types.ts 先例）
// SSEEvent 与 src/adapters/web-channel.ts 的 SSEEvent 保持一致

/** SSE 事件类型 */
export type SSEEvent =
  | { type: "text"; text: string }
  | { type: "text_delta"; messageId: string; text: string }
  | { type: "activity"; text: string }
  | { type: "approval_card"; gateId: string; title: string; summary: string }
  | {
      type: "credential_card";
      reqId: string;
      conversationId: string;
      items: Array<{
        key: string;
        label: string;
        description?: string;
        secret: boolean;
        packName: string;
      }>;
    }
  | { type: "result"; subtype: "success" | "error"; text: string }
  | { type: "error"; error: string };

/** 会话摘要（GET /api/conversations 返回项的子集） */
export interface ConversationSummary {
  id: string;
  userId: string;
  title: string;
  channelId: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
}

/** 智能体摘要（GET /api/agents 返回项的子集） */
export interface AgentSummary {
  id: string;
  name: string;
  description?: string;
  _mine: boolean;
}

/** /api/auth/exchange 与 /api/auth/me 的用户字段（子集） */
export interface UserSummary {
  id: string;
  name: string;
  role: string;
}
