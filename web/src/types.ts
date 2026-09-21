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
  | {
      type: "ask_user_question";
      reqId: string;
      conversationId: string;
      questions: PendingQuestionItem[];
    }
  | { type: "result"; subtype: "success" | "error"; text: string }
  | { type: "activity"; text: string }
  | {
      type: "eviction_notice";
      taskId: string;
      conversationId: string;
      taskExcerpt: string;
      startedAt: string;
      pendingSince: string;
      canceledAt: string;
    }
  | { type: "error"; error: string };

/** 并发淘汰通知（eviction_notice 事件的前端形态，弹窗展示用） */
export interface EvictionNotice {
  taskId: string;
  conversationId: string;
  taskExcerpt: string;
  startedAt: string;
  pendingSince: string;
  canceledAt: string;
}

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
    type: "image" | "markdown" | "document";
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

/** AskUserQuestion 单个问题（与后端 QuestionItem 对齐） */
export interface PendingQuestionItem {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** 一轮待作答问题（SSE ask_user_question / GET pending-question 共用） */
export interface PendingQuestion {
  reqId: string;
  questions: PendingQuestionItem[];
}

export type ConnectionState = "connecting" | "open" | "closed";

export type ChatErrorKey =
  | "conversations"
  | "messages"
  | "stream"
  | "approval"
  | "credential"
  | "question";

export type ChatErrors = Partial<Record<ChatErrorKey, string>>;

/** 会话权限模式：full_access 跳过工具审批门（白名单/写边界/shell git 守卫不受影响） */
export type AgentPermissionMode = "ask_before_change" | "full_access";

/** 会话摘要（从 GET /api/conversations 返回） */
export interface ConversationSummary {
  id: string;
  userId: string;
  sdkSessionId: string;
  title: string;
  channelId: string;
  agentId: string;
  /** 会话级权限模式覆盖；空 = 跟随绑定智能体的默认配置 */
  permissionMode?: AgentPermissionMode;
  /** 生效权限模式（后端按 会话覆盖 ?? 智能体默认 ?? 变更前问询 计算） */
  effectivePermissionMode?: AgentPermissionMode;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** 仅前端存在的未保存会话草稿。 */
  isDraft?: boolean;
}

export interface ChatState {
  messages: ChatMessage[];
  isGenerating: boolean;
  /** 当前执行阶段横幅（🔨 执行阶段等，后端 activity 事件；过程态，不随历史回放） */
  stage: string | null;
  pendingApproval: PendingApproval | null;
  pendingCredential: PendingCredential | null;
  pendingQuestion: PendingQuestion | null;
  /** 并发淘汰弹窗（最新一条；用户关闭后清空） */
  evictionNotice: EvictionNotice | null;
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
