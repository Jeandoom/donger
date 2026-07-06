// 前端类型定义（SSE+HTTP 版本）
// 与 src/adapters/web-channel.ts 的 SSEEvent 保持一致

/** SSE 事件类型 */
export type SSEEvent =
  | { type: "text"; text: string }
  | { type: "approval_card"; gateId: string; title: string; summary: string }
  | { type: "result"; subtype: "success" | "error"; text: string }
  | { type: "error"; error: string };

export type ChatRole = "user" | "bot";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
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

export type ConnectionState = "connecting" | "open" | "closed";

/** 会话摘要（从 GET /api/conversations 返回） */
export interface ConversationSummary {
  id: string;
  userId: string;
  sdkSessionId: string;
  title: string;
  channelId: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface ChatState {
  messages: ChatMessage[];
  pendingApproval: PendingApproval | null;
  connection: ConnectionState;
  /** 用户会话列表 */
  conversations: ConversationSummary[];
  /** 当前活跃会话 ID */
  activeConversationId: string | null;
  /** 会话列表加载中 */
  loadingConversations: boolean;
  /** 历史消息加载中 */
  loadingMessages: boolean;
}
