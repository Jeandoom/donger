import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ConversationSummary, WsIn, WsOut } from "../types";
import type { FileInfo } from "./chatReducer";
import { chatReducer, initialChatState } from "./chatReducer";
import { clearToken, getToken } from "./auth";

export function useWebChat(url: string) {
  const [state, dispatch] = useReducer(chatReducer, undefined, initialChatState);
  const wsRef = useRef<WebSocket | null>(null);

  // 从 JWT 中解析 userId
  const getUserId = useCallback((): string => {
    const token = getToken();
    if (!token) return "web-user";
    try {
      const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
      return payload.sub ?? "web-user";
    } catch {
      return "web-user";
    }
  }, []);

  /** 创建新会话 */
  const createNewConversation = useCallback(async () => {
    try {
      const token = getToken();
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ userId: getUserId(), channelId: "web" }),
      });
      const conv: ConversationSummary = await res.json();
      dispatch({ type: "new_conversation", conversation: conv });
      return conv;
    } catch {
      return null;
    }
  }, [getUserId]);

  /** 加载会话列表 */
  const loadConversations = useCallback(async () => {
    try {
      const token = getToken();
      const res = await fetch(`/api/conversations?userId=${encodeURIComponent(getUserId())}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const list: ConversationSummary[] = await res.json();
      dispatch({ type: "set_conversations", conversations: list });
    } catch {
      /* 忽略 */
    }
  }, [getUserId]);

  useEffect(() => {
    dispatch({ type: "connection", state: "connecting" });
    // WebSocket 连接带 token
    const token = getToken();
    const wsUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      dispatch({ type: "connection", state: "open" });
      createNewConversation().catch(() => {});
      loadConversations().catch(() => {});
    };
    ws.onclose = (ev) => {
      dispatch({ type: "connection", state: "closed" });
      // 如果是 4001 (token 无效)，清除 token 并跳转登录
      if (ev.code === 4001) {
        clearToken();
        window.location.href = "/login";
      }
    };
    ws.onmessage = (ev) => {
      try {
        dispatch({ type: "ws", msg: JSON.parse(ev.data) as WsOut });
      } catch {
        /* 忽略非法帧 */
      }
    };
    return () => ws.close();
  }, [url, createNewConversation, loadConversations]);

  /** 切换会话 */
  const switchConversation = useCallback((conversationId: string | null) => {
    dispatch({ type: "switch_conversation", conversationId });
  }, []);

  /** 新建会话 */
  const newConversation = useCallback(async () => {
    await createNewConversation();
  }, [createNewConversation]);

  const send = useCallback(
    (text: string, files?: FileInfo[]) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      dispatch({ type: "user_message", text, files });
      const out: WsIn = {
        type: "message",
        text,
        files,
        conversationId: state.activeConversationId ?? undefined,
      };
      ws.send(JSON.stringify(out));
    },
    [state.activeConversationId],
  );

  const resolveApproval = useCallback((approved: boolean, reason?: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const out: WsIn = { type: "approval", approved, reason };
    ws.send(JSON.stringify(out));
    dispatch({ type: "clear_approval" });
  }, []);

  return {
    ...state,
    send,
    resolveApproval,
    switchConversation,
    newConversation,
    loadConversations,
  };
}