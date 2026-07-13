import type { ChatMessage, ChatState, ConversationSummary, SSEEvent } from "../types";

export type FileInfo = {
  path: string;
  name: string;
  type: "image" | "markdown";
};

export type ChatAction =
  | { type: "connection"; state: "connecting" | "open" | "closed" }
  | { type: "ws"; msg: SSEEvent }
  | { type: "user_message"; text: string; files?: FileInfo[] }
  | { type: "clear_approval" }
  | { type: "clear_credential" }
  | { type: "set_conversations"; conversations: ConversationSummary[] }
  | { type: "switch_conversation"; conversationId: string | null }
  | { type: "new_conversation"; conversation: ConversationSummary }
  | { type: "set_messages"; messages: ChatMessage[] }
  | { type: "loading_messages"; loading: boolean }
  | { type: "remove_conversation"; conversationId: string };

export function initialChatState(): ChatState {
  return {
    messages: [],
    pendingApproval: null,
    pendingCredential: null,
    connection: "connecting",
    conversations: [],
    activeConversationId: null,
    loadingConversations: true,
    loadingMessages: false,
  };
}

let fallbackId = 0;

// This is only a non-persistent React key; randomUUID may be absent on insecure origins.
function makeId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  fallbackId += 1;
  return `local-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

function appendBot(state: ChatState, text: string): ChatState {
  const msg: ChatMessage = { id: makeId(), role: "bot", text };
  return { ...state, messages: [...state.messages, msg] };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "connection":
      return { ...state, connection: action.state };
    case "user_message": {
      const msg: ChatMessage = {
        id: makeId(),
        role: "user",
        text: action.text,
        files: action.files,
      };
      return { ...state, messages: [...state.messages, msg] };
    }
    case "clear_approval":
      return { ...state, pendingApproval: null };
    case "clear_credential":
      return { ...state, pendingCredential: null };
    case "ws":
      return applyWsOut(state, action.msg);
    case "set_conversations":
      return {
        ...state,
        conversations: action.conversations,
        loadingConversations: false,
      };
    case "switch_conversation":
      return {
        ...state,
        activeConversationId: action.conversationId,
        messages: [],
        loadingMessages: true,
      };
    case "new_conversation":
      return {
        ...state,
        conversations: [action.conversation, ...state.conversations],
        activeConversationId: action.conversation.id,
        messages: [],
        loadingConversations: false,
        loadingMessages: false,
      };
    case "set_messages":
      return { ...state, messages: action.messages, loadingMessages: false };
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
      return appendBot(state, msg.text);
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
      if (msg.subtype === "success") {
        return appendBot(state, msg.text);
      }
      return state;
    default:
      return state;
  }
}
