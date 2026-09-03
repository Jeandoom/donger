import type {
  ChatErrorKey,
  ChatMessage,
  ChatState,
  ConversationSummary,
  MessageDelivery,
  SSEEvent,
} from "../types";

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
  | { type: "set_conversations"; conversations: ConversationSummary[] }
  | { type: "switch_conversation"; conversationId: string | null }
  | { type: "new_conversation"; conversation: ConversationSummary }
  | { type: "persist_conversation"; draftId: string; conversation: ConversationSummary }
  | { type: "set_messages"; messages: ChatMessage[] }
  | { type: "loading_messages"; loading: boolean }
  | { type: "remove_conversation"; conversationId: string }
  | { type: "set_error"; key: ChatErrorKey; message: string }
  | { type: "clear_error"; key: ChatErrorKey };

export function initialChatState(): ChatState {
  return {
    messages: [],
    isGenerating: false,
    pendingApproval: null,
    pendingCredential: null,
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

function appendBot(state: ChatState, text: string): ChatState {
  const msg: ChatMessage = { id: makeId(), role: "bot", text };
  return { ...state, messages: [...state.messages, msg] };
}

function appendBotDelta(state: ChatState, messageId: string, text: string): ChatState {
  const existing = state.messages.find((message) => message.id === messageId);
  if (!existing && !text.trim()) return { ...state, isGenerating: true };
  const messages = existing
    ? state.messages.map((message) =>
        message.id === messageId ? { ...message, text: message.text + text } : message,
      )
    : [...state.messages, { id: messageId, role: "bot" as const, text }];
  return { ...state, messages, isGenerating: true };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "connection":
      return { ...state, connection: action.state };
    case "generation":
      return { ...state, isGenerating: action.running };
    case "set_error":
      return { ...state, errors: { ...state.errors, [action.key]: action.message } };
    case "clear_error": {
      const { [action.key]: _removed, ...remaining } = state.errors;
      return { ...state, errors: remaining };
    }
    case "user_message": {
      const msg: ChatMessage = {
        id: action.id ?? makeId(),
        role: "user",
        text: action.text,
        files: action.files,
        delivery: "sending",
      };
      return { ...state, messages: [...state.messages, msg], isGenerating: true };
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
      return { ...state, messages: action.messages, loadingMessages: false, isGenerating: false };
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
    default:
      return state;
  }
}

function applyWsOut(state: ChatState, msg: SSEEvent): ChatState {
  switch (msg.type) {
    case "text":
      return msg.text ? appendBot(state, msg.text) : state;
    case "text_delta":
      return appendBotDelta(state, msg.messageId, msg.text);
    case "approval_card":
      return {
        ...state,
        pendingApproval: { gateId: msg.gateId, title: msg.title, summary: msg.summary },
      };
    case "credential_card":
      return {
        ...state,
        pendingCredential: { reqId: msg.reqId, items: msg.items },
      };
    case "result":
      return { ...state, isGenerating: false };
    case "error":
      return {
        ...state,
        isGenerating: false,
        errors: { ...state.errors, stream: msg.error },
      };
    default:
      return state;
  }
}
