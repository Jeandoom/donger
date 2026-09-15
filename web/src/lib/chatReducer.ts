import type {
  ChatErrorKey,
  ChatMessage,
  ChatState,
  ConversationSummary,
  MessageDelivery,
  PendingQuestion,
  SSEEvent,
  TurnPart,
} from "../types";
import { finalizeTurnParts } from "./turnAssembly";

export type FileInfo = {
  path: string;
  name: string;
  type: "image" | "markdown";
};

export type ChatAction =
  | { type: "connection"; state: "connecting" | "open" | "closed" }
  | { type: "generation"; running: boolean }
  | { type: "ws"; msg: SSEEvent }
  | { type: "user_message"; id?: string; text: string; files?: FileInfo[] }
  | { type: "message_delivery"; id: string; delivery: MessageDelivery }
  | { type: "clear_approval" }
  | { type: "clear_credential" }
  | { type: "clear_question" }
  | { type: "set_pending_question"; question: PendingQuestion | null }
  | { type: "set_conversations"; conversations: ConversationSummary[] }
  | { type: "switch_conversation"; conversationId: string | null }
  | { type: "new_conversation"; conversation: ConversationSummary }
  | { type: "persist_conversation"; draftId: string; conversation: ConversationSummary }
  | { type: "set_messages"; messages: ChatMessage[] }
  | { type: "loading_messages"; loading: boolean }
  | { type: "remove_conversation"; conversationId: string }
  | {
      type: "update_conversation";
      conversationId: string;
      patch: Partial<ConversationSummary>;
    }
  | { type: "set_error"; key: ChatErrorKey; message: string }
  | { type: "clear_error"; key: ChatErrorKey };

export function initialChatState(): ChatState {
  return {
    messages: [],
    isGenerating: false,
    stage: null,
    pendingApproval: null,
    pendingCredential: null,
    pendingQuestion: null,
    connection: "connecting",
    conversations: [],
    activeConversationId: null,
    loadingConversations: true,
    loadingMessages: false,
    errors: {},
  };
}

let fallbackId = 0;

// This is only a non-persistent React key; randomUUID may be absent on insecure origins.
export function makeId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  fallbackId += 1;
  return `local-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

export function isDraftConversation(conversation: ConversationSummary | undefined): boolean {
  return conversation?.isDraft === true;
}

/** 取或建当前进行中的回合（最后一个 running 状态的回合消息），返回新消息数组与回合下标 */
function ensureTurn(messages: ChatMessage[]): { messages: ChatMessage[]; index: number } {
  const last = messages[messages.length - 1];
  if (last && last.role === "bot" && last.kind === "turn" && last.state === "running") {
    return { messages, index: messages.length - 1 };
  }
  const turn: ChatMessage = {
    id: makeId(),
    role: "bot",
    text: "",
    kind: "turn",
    parts: [],
    state: "running",
  };
  return { messages: [...messages, turn], index: messages.length };
}

function mapTurnParts(
  messages: ChatMessage[],
  index: number,
  fn: (parts: TurnPart[]) => TurnPart[],
): ChatMessage[] {
  return messages.map((message, i) =>
    i === index ? { ...message, parts: fn(message.parts ?? []) } : message,
  );
}

/** 追加思考/文本增量：同一分片（messageId 相同且不跨工具段）继续拼接，否则新开分片 */
function appendStreamPart(
  parts: TurnPart[],
  kind: "text" | "thinking",
  messageId: string,
  text: string,
): TurnPart[] {
  const match = findStreamPart(parts, kind, messageId);
  const part = match >= 0 ? parts[match] : undefined;
  if (part && part.kind !== "tool") {
    const next = parts.slice();
    next[match] = { ...part, text: part.text + text };
    return next;
  }
  return [...parts, kind === "text" ? { kind, messageId, text } : { kind, messageId, text }];
}

/** 从尾部向前找同 messageId 的流式分片（不跨工具段） */
function findStreamPart(parts: TurnPart[], kind: "text" | "thinking", messageId: string): number {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (!part || part.kind === "tool") return -1;
    if (part.kind === kind && part.messageId === messageId) return i;
  }
  return -1;
}

/** 进行中的回合（若有）的当前分片 */
function runningTurnParts(messages: ChatMessage[]): TurnPart[] {
  const last = messages[messages.length - 1];
  if (last && last.role === "bot" && last.kind === "turn" && last.state === "running") {
    return last.parts ?? [];
  }
  return [];
}

/** 把回合收口（state 置位 + 工具分片终结），返回新消息数组 */
function closeTurn(messages: ChatMessage[], state: "done" | "error"): ChatMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role === "bot" && message.kind === "turn" && message.state === "running") {
      changed = true;
      return { ...message, state, parts: finalizeTurnParts(message.parts ?? []) };
    }
    return message;
  });
  return changed ? next : messages;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "connection":
      return { ...state, connection: action.state };
    case "generation":
      // 流终止（取消/断线/完成）：收口所有进行中的回合
      return action.running
        ? { ...state, isGenerating: true }
        : {
            ...state,
            isGenerating: false,
            stage: null,
            messages: closeTurn(state.messages, "done"),
          };
    case "set_error":
      return { ...state, errors: { ...state.errors, [action.key]: action.message } };
    case "clear_error": {
      const { [action.key]: _removed, ...remaining } = state.errors;
      return { ...state, errors: remaining };
    }
    case "user_message": {
      // 防御：上一回合未收到 result 时（漏事件）也在新用户消息处收口
      const messages = closeTurn(state.messages, "done");
      const msg: ChatMessage = {
        id: action.id ?? makeId(),
        role: "user",
        text: action.text,
        files: action.files,
        delivery: "sending",
      };
      return { ...state, messages: [...messages, msg], isGenerating: true, stage: null };
    }
    case "message_delivery":
      return {
        ...state,
        isGenerating: action.delivery === "failed" ? false : state.isGenerating,
        messages: state.messages.map((message) =>
          message.id === action.id ? { ...message, delivery: action.delivery } : message,
        ),
      };
    case "clear_approval":
      return { ...state, pendingApproval: null };
    case "clear_credential":
      return { ...state, pendingCredential: null };
    case "clear_question":
      return { ...state, pendingQuestion: null };
    case "set_pending_question":
      return { ...state, pendingQuestion: action.question };
    case "ws":
      return applyWsOut(state, action.msg);
    case "set_conversations":
      return {
        ...state,
        conversations: [
          ...state.conversations.filter((conversation) => conversation.isDraft),
          ...action.conversations,
        ],
        loadingConversations: false,
      };
    case "switch_conversation": {
      const conversation = state.conversations.find((item) => item.id === action.conversationId);
      const isDraft = isDraftConversation(conversation);
      return {
        ...state,
        activeConversationId: action.conversationId,
        messages: [],
        isGenerating: false,
        stage: null,
        pendingQuestion: null,
        loadingMessages: !isDraft && action.conversationId !== null,
      };
    }
    case "new_conversation": {
      const existingDraft = state.conversations.find((item) => item.isDraft);
      if (existingDraft) {
        return {
          ...state,
          activeConversationId: existingDraft.id,
          messages: state.activeConversationId === existingDraft.id ? state.messages : [],
          isGenerating: false,
          loadingMessages: false,
        };
      }
      return {
        ...state,
        conversations: [action.conversation, ...state.conversations],
        activeConversationId: action.conversation.id,
        messages: [],
        isGenerating: false,
        loadingConversations: false,
        loadingMessages: false,
      };
    }
    case "persist_conversation":
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.id === action.draftId ? action.conversation : conversation,
        ),
        activeConversationId:
          state.activeConversationId === action.draftId
            ? action.conversation.id
            : state.activeConversationId,
      };
    case "set_messages":
      return {
        ...state,
        messages: action.messages,
        loadingMessages: false,
        isGenerating: false,
        stage: null,
      };
    case "loading_messages":
      return { ...state, loadingMessages: action.loading };
    case "remove_conversation": {
      const remaining = state.conversations.filter((c) => c.id !== action.conversationId);
      const isActive = state.activeConversationId === action.conversationId;
      return {
        ...state,
        conversations: remaining,
        activeConversationId: isActive ? (remaining[0]?.id ?? null) : state.activeConversationId,
        messages: isActive ? [] : state.messages,
        isGenerating: isActive ? false : state.isGenerating,
        loadingMessages: isActive ? false : state.loadingMessages,
      };
    }
    case "update_conversation":
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === action.conversationId ? { ...c, ...action.patch } : c,
        ),
      };
    default:
      return state;
  }
}

let fullTextSeq = 0;

function applyWsOut(state: ChatState, msg: SSEEvent): ChatState {
  switch (msg.type) {
    case "activity":
      // 阶段横幅（🔨 执行阶段等）：过程态，替换式更新，不进消息流（不随历史回放）
      return { ...state, isGenerating: true, stage: msg.text };
    case "thinking_delta": {
      if (!msg.text) return state;
      // 空白增量且无既有分片承接：不新开回合（沿用 SSE 连接 ack 不建行的既有行为），仅翻转生成态
      if (
        !msg.text.trim() &&
        findStreamPart(runningTurnParts(state.messages), "thinking", msg.messageId) < 0
      ) {
        return { ...state, isGenerating: true };
      }
      const { messages, index } = ensureTurn(state.messages);
      return {
        ...state,
        isGenerating: true,
        messages: mapTurnParts(messages, index, (parts) =>
          appendStreamPart(parts, "thinking", msg.messageId, msg.text),
        ),
      };
    }
    case "text_delta": {
      if (!msg.text) return state;
      if (
        !msg.text.trim() &&
        findStreamPart(runningTurnParts(state.messages), "text", msg.messageId) < 0
      ) {
        return { ...state, isGenerating: true };
      }
      const { messages, index } = ensureTurn(state.messages);
      return {
        ...state,
        isGenerating: true,
        messages: mapTurnParts(messages, index, (parts) =>
          appendStreamPart(parts, "text", msg.messageId, msg.text),
        ),
      };
    }
    case "text": {
      // 完整文本段：仅在后端未流过 delta 时推送，直接作为新分片追加
      if (!msg.text) return state;
      fullTextSeq += 1;
      const { messages, index } = ensureTurn(state.messages);
      return {
        ...state,
        isGenerating: true,
        messages: mapTurnParts(messages, index, (parts) => [
          ...parts,
          { kind: "text", messageId: `full-${fullTextSeq}`, text: msg.text },
        ]),
      };
    }
    case "tool_use": {
      const { messages, index } = ensureTurn(state.messages);
      return {
        ...state,
        isGenerating: true,
        messages: mapTurnParts(messages, index, (parts) => [
          ...parts,
          {
            kind: "tool",
            toolUseId: msg.toolUseId,
            tool: msg.tool,
            inputPreview: msg.inputPreview,
            state: "running",
          },
        ]),
      };
    }
    case "tool_result": {
      const { messages, index } = ensureTurn(state.messages);
      return {
        ...state,
        messages: mapTurnParts(messages, index, (parts) => {
          const next = parts.slice();
          for (let i = next.length - 1; i >= 0; i -= 1) {
            const part = next[i];
            if (!part) continue;
            if (part.kind === "tool" && part.toolUseId === msg.toolUseId) {
              next[i] = {
                ...part,
                outputPreview: msg.outputPreview,
                isError: msg.isError,
                state: msg.isError ? "error" : "done",
              };
              return next;
            }
          }
          // 找不到对应 tool_use（如 reducer 中途重挂）：降级为完整工具分片
          return [
            ...next,
            {
              kind: "tool",
              toolUseId: msg.toolUseId,
              tool: "tool",
              inputPreview: "",
              outputPreview: msg.outputPreview,
              isError: msg.isError,
              state: msg.isError ? "error" : "done",
            },
          ];
        }),
      };
    }
    case "approval_card":
      return {
        ...state,
        pendingApproval: { gateId: msg.gateId, title: msg.title, summary: msg.summary },
      };
    case "credential_missing_card":
      return {
        ...state,
        pendingCredential: { reqId: msg.reqId, items: msg.items },
      };
    case "ask_user_question":
      return {
        ...state,
        pendingQuestion: { reqId: msg.reqId, questions: msg.questions },
      };
    case "result": {
      const closed = closeTurn(state.messages, msg.subtype === "error" ? "error" : "done");
      return { ...state, isGenerating: false, messages: closed, pendingQuestion: null };
    }
    case "error":
      return {
        ...state,
        isGenerating: false,
        messages: closeTurn(state.messages, "error"),
        errors: { ...state.errors, stream: msg.error },
        pendingQuestion: null,
      };
    default:
      return state;
  }
}
