// 本地复制 WS 消息类型（与 src/adapters/web-channel.ts 的 WsIn/WsOut 保持一致）。
// 不 import 后端源码，避免拖入 node 依赖。

export type WsIn =
  | {
      type: "message";
      text: string;
      userId?: string;
      conversationId?: string;
      files?: Array<{
        path: string;
        name: string;
        type: "image" | "markdown";
      }>;
    }
  | { type: "approval"; approved: boolean; reason?: string };

export type WsOut =
  | { type: "text"; text: string }
  | { type: "approval_card"; gateId: string; title: string; summary: string }
  | { type: "result"; subtype: "success" | "error"; text: string };

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
}
