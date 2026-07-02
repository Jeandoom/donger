import type { ChatMessage, ChatState, WsOut } from "../types";

export type FileInfo = {
  path: string;
  name: string;
  type: "image" | "markdown";
};

export type ChatAction =
  | { type: "connection"; state: "connecting" | "open" | "closed" }
  | { type: "ws"; msg: WsOut }
  | { type: "user_message"; text: string; files?: FileInfo[] }
  | { type: "clear_approval" };

export function initialChatState(): ChatState {
  return { messages: [], pendingApproval: null, connection: "connecting" };
}

// ponytail: crypto.randomUUID 作 React key，浏览器与 Node20+ 均可用；非持久化路径。
function makeId(): string {
  return crypto.randomUUID();
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
    case "ws":
      return applyWsOut(state, action.msg);
    default:
      return state;
  }
}

function applyWsOut(state: ChatState, msg: WsOut): ChatState {
  switch (msg.type) {
    case "text":
      return appendBot(state, msg.text);
    case "approval_card":
      return {
        ...state,
        pendingApproval: { gateId: msg.gateId, title: msg.title, summary: msg.summary },
      };
    case "result":
      return appendBot(state, msg.text);
    default:
      return state;
  }
}
