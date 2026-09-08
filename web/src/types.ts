// 前端类型定义（SSE+HTTP 版本）
// 与 src/adapters/web-channel.ts 的 SSEEvent 保持一致

/** SSE 事件类型 */
export type SSEEvent =
  | { type: "text"; text: string }
  | { type: "text_delta"; messageId: string; text: string }
  | { type: "approval_card"; gateId: string; title: string; summary: string }
  | {
      type: "credential_missing_card";
      reqId: string;
      conversationId: string;
      items: Array<{
        code: string;
        name: string;
        description?: string;
        keys: string[];
      }>;
    }
  | { type: "result"; subtype: "success" | "error"; text: string }
  | { type: "error"; error: string };

export type ChatRole = "user" | "bot";

export type MessageDelivery = "sending" | "accepted" | "failed";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  delivery?: MessageDelivery;
  files?: Array<{
    path: string;
    name: string;
    type: "image" | "markdown";
  }>;
}

export interface PendingApproval {
  gateId: string;
  title: string;
  summary: string;
}

export interface PendingCredential {
  reqId: string;
  items: Array<{
    code: string;
    name: string;
    description?: string;
    keys: string[];
  }>;
}

export type ConnectionState = "connecting" | "open" | "closed";

export type ChatErrorKey = "conversations" | "messages" | "stream" | "approval" | "credential";

export type ChatErrors = Partial<Record<ChatErrorKey, string>>;

/** 会话摘要（从 GET /api/conversations 返回） */
export interface ConversationSummary {
  id: string;
  userId: string;
  sdkSessionId: string;
  title: string;
  channelId: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** 仅前端存在的未保存会话草稿。 */
  isDraft?: boolean;
}

export interface ChatState {
  messages: ChatMessage[];
  isGenerating: boolean;
  pendingApproval: PendingApproval | null;
  pendingCredential: PendingCredential | null;
  connection: ConnectionState;
  /** 用户会话列表 */
  conversations: ConversationSummary[];
  /** 当前活跃会话 ID */
  activeConversationId: string | null;
  /** 会话列表加载中 */
  loadingConversations: boolean;
  /** 历史消息加载中 */
  loadingMessages: boolean;
  errors: ChatErrors;
}
