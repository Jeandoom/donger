import { useCallback, useEffect, useReducer, useRef, useState } from "react";
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

  /** 切换会话 */
  const switchConversation = useCallback((conversationId: string | null) => {
    dispatch({ type: "switch_conversation", conversationId });
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

  // 会话列表加载后：有历史会话则自动进入最新，无历史则创建新会话
  const [autoInitDone, setAutoInitDone] = useState(false);
  useEffect(() => {
    if (state.loadingConversations || autoInitDone) return;
    const first = state.conversations[0];
    if (first) {
      switchConversation(first.id);
    } else {
      createNewConversation().catch(() => {});
    }
    setAutoInitDone(true);
  }, [state.loadingConversations, state.conversations, autoInitDone, switchConversation, createNewConversation]);

  useEffect(() => {
    dispatch({ type: "connection", state: "connecting" });
    // WebSocket 连接带 token
    const token = getToken();
    const wsUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      dispatch({ type: "connection", state: "open" });
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
  }, [url, loadConversations]);

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

  /** 删除会话（软删除，归档） */
  const deleteConversation = useCallback(async (id: string) => {
    if (window.confirm("确认删除该会话？")) {
      try {
        const token = getToken();
        await fetch(`/api/conversations/${id}`, {
          method: "DELETE",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        dispatch({ type: "remove_conversation", conversationId: id });
      } catch {
        /* 忽略 */
      }
    }
  }, [getUserId]);

  return {
    ...state,
    send,
    resolveApproval,
    switchConversation,
    newConversation,
    loadConversations,
    deleteConversation,
  };
}
