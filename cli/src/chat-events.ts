import type { SSEEvent } from "./types.js";

/** SSE 事件 → 终端动作（纯函数，REPL 据此渲染/交互） */
export type EventAction =
  | { kind: "print"; text: string }
  | { kind: "delta"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "activity"; text: string }
  | { kind: "round_end"; ok: boolean; text: string }
  | { kind: "approval"; gateId: string; title: string; summary: string }
  | {
      kind: "credential";
      reqId: string;
      items: Array<{ key: string; label: string; description?: string; secret: boolean }>;
    }
  | { kind: "ignore" };

/**
 * 事件分类。streaming 记录当前流式输出的 messageId：
 * 其后到达的完整 text 视为同一条消息的定稿，跳过防重复（同后端 event-bridge 语义）；
 * 空 text 是后端连接确认事件，忽略。
 */
export function classifyEvent(e: SSEEvent, streaming: { messageId: string | null }): EventAction {
  switch (e.type) {
    case "text_delta":
      streaming.messageId = e.messageId;
      return { kind: "delta", text: e.text };
    case "thinking_delta":
      return { kind: "thinking", text: e.text };
    case "activity":
      return { kind: "activity", text: e.text };
    case "text": {
      if (streaming.messageId) {
        streaming.messageId = null;
        return { kind: "ignore" };
      }
      if (!e.text) return { kind: "ignore" };
      return { kind: "print", text: e.text };
    }
    case "approval_card":
      return { kind: "approval", gateId: e.gateId, title: e.title, summary: e.summary };
    case "credential_card":
      return { kind: "credential", reqId: e.reqId, items: e.items };
    case "result":
      return { kind: "round_end", ok: e.subtype === "success", text: e.text };
    case "error":
      return { kind: "print", text: `❌ ${e.error}` };
  }
}
