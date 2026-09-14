// 前端类型定义（SSE+HTTP 版本）
// 与 src/adapters/web-channel.ts 的 SSEEvent 保持一致

/** SSE 事件类型（与 src/adapters/web-channel.ts 的 SSEEvent 保持一致） */
export type SSEEvent =
  | { type: "text"; text: string }
  | { type: "text_delta"; messageId: string; text: string }
  | { type: "thinking_delta"; messageId: string; text: string }
  | { type: "tool_use"; toolUseId: string; tool: string; inputPreview: string }
  | { type: "tool_result"; toolUseId: string; outputPreview: string; isError: boolean }
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

/** 回合内的分型内容片段（同一回合内按时间线有序） */
export type TurnPart =
  | { kind: "text"; messageId: string; text: string }
  | { kind: "thinking"; messageId: string; text: string }
  | {
      kind: "tool";
      toolUseId: string;
      tool: string;
      inputPreview: string;
      outputPreview?: string;
      isError?: boolean;
      state: "running" | "done" | "error";
    };

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** 历史消息的落库时间（ISO）；本轮流式/本地乐观消息可能缺省 */
  createdAt?: string;
  delivery?: MessageDelivery;
  files?: Array<{
    path: string;
    name: string;
    type: "image" | "markdown";
  }>;
  /** 回合聚合消息（role=bot）：正文/思考/工具按时间线分片；缺省=旧式纯文本消息 */
  kind?: "turn";
  parts?: TurnPart[];
  /** 回合状态：running=流式进行中；done/error=已收口 */
  state?: "running" | "done" | "error";
  /** 归属任务 id（历史消息带，装饰/调试用） */
  taskId?: string;
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
