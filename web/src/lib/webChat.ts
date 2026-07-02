import { useCallback, useEffect, useReducer, useRef } from "react";
import type { WsIn, WsOut } from "../types";
import { chatReducer, initialChatState } from "./chatReducer";
import type { FileInfo } from "./chatReducer";

export function useWebChat(url: string) {
  const [state, dispatch] = useReducer(chatReducer, undefined, initialChatState);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    dispatch({ type: "connection", state: "connecting" });
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => dispatch({ type: "connection", state: "open" });
    ws.onclose = () => dispatch({ type: "connection", state: "closed" });
    ws.onmessage = (ev) => {
      try {
        dispatch({ type: "ws", msg: JSON.parse(ev.data) as WsOut });
      } catch {
        /* 忽略非法帧 */
      }
    };
    return () => ws.close();
  }, [url]);

  const send = useCallback((text: string, files?: FileInfo[]) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    dispatch({ type: "user_message", text, files });
    const out: WsIn = { type: "message", text, files };
    ws.send(JSON.stringify(out));
  }, []);

  const resolveApproval = useCallback((approved: boolean, reason?: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const out: WsIn = { type: "approval", approved, reason };
    ws.send(JSON.stringify(out));
    dispatch({ type: "clear_approval" });
  }, []);

  return { ...state, send, resolveApproval };
}
