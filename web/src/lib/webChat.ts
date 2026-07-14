import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ChatMessage, ConversationSummary, SSEEvent } from "../types";
import { getToken } from "./auth";
import type { FileInfo } from "./chatReducer";
import { chatReducer, initialChatState, makeId } from "./chatReducer";

type SSEClient = {
  close(): void;
};

export function useWebChat() {
  const [state, dispatch] = useReducer(chatReducer, undefined, initialChatState);
  const sseRef = useRef<SSEClient | null>(null);
  const messagesRequestRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();

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

  /** 创建新会话（agentId 缺省=默认会话） */
  const createNewConversation = useCallback(
    async (agentId?: string) => {
      try {
        const token = getToken();
        const res = await fetch("/api/conversations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ userId: getUserId(), channelId: "web", agentId }),
        });
        const conv: ConversationSummary = await res.json();
        dispatch({ type: "new_conversation", conversation: conv });
        return conv;
      } catch {
        return null;
      }
    },
    [getUserId],
  );

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

  /** 连接 SSE 流 */
  const connectSSE = useCallback((conversationId: string) => {
    // EventSource 无法设置 Authorization 头，改用 ?token= 查询参数鉴权
    const token = getToken();
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    const eventSource = new EventSource(`/api/conversations/${conversationId}/stream${qs}`);

    sseRef.current = {
      close: () => eventSource.close(),
    };

    eventSource.addEventListener("text", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEEvent;
        if (data.type === "text") {
          dispatch({ type: "ws", msg: data });
        }
      } catch {
        // ignore
      }
    });

    eventSource.addEventListener("approval_card", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEEvent;
        if (data.type === "approval_card") {
          dispatch({ type: "ws", msg: data });
        }
      } catch {
        // ignore
      }
    });

    eventSource.addEventListener("credential_card", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEEvent;
        if (data.type === "credential_card") {
          dispatch({ type: "ws", msg: data });
        }
      } catch {
        // ignore
      }
    });

    eventSource.addEventListener("result", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEEvent;
        if (data.type === "result") {
          dispatch({ type: "ws", msg: data });
        }
      } catch {
        // ignore
      }
    });

    eventSource.addEventListener("error", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEEvent;
        if (data.type === "error") {
          console.error("[SSE]", data.error);
        }
      } catch {
        // ignore
      }
      // EventSource 会自动重连，无需手动处理
    });

    eventSource.onopen = () => {
      dispatch({ type: "connection", state: "open" });
    };

    return eventSource;
  }, []);

  // 初始连接
  useEffect(() => {
    dispatch({ type: "connection", state: "connecting" });
    loadConversations().catch(() => {});
  }, [loadConversations]);

  // 连接/重连 SSE
  useEffect(() => {
    if (!state.activeConversationId) return;

    const eventSource = connectSSE(state.activeConversationId);

    return () => {
      eventSource.close();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, [state.activeConversationId, connectSSE]);

  useEffect(() => () => messagesRequestRef.current?.abort(), []);

  /** 切换会话（先清空本地消息，再异步加载历史消息） */
  const switchConversation = useCallback((conversationId: string | null) => {
    messagesRequestRef.current?.abort();
    dispatch({ type: "switch_conversation", conversationId });
    if (!conversationId) return;
    const controller = new AbortController();
    messagesRequestRef.current = controller;
    const token = getToken();
    fetch(`/api/conversations/${conversationId}/messages`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<ChatMessage[]>;
      })
      .then((messages) => {
        if (messagesRequestRef.current === controller) {
          dispatch({ type: "set_messages", messages });
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (messagesRequestRef.current === controller) {
          dispatch({ type: "set_messages", messages: [] });
        }
      })
      .finally(() => {
        if (messagesRequestRef.current === controller) messagesRequestRef.current = null;
      });
  }, []);

  /** 新建会话（可指定 agentId 绑定智能体） */
  const newConversation = useCallback(
    async (agentId?: string) => {
      await createNewConversation(agentId);
    },
    [createNewConversation],
  );

  const send = useCallback(
    async (text: string, files?: FileInfo[]): Promise<void> => {
      const conversationId = state.activeConversationId;
      if (!conversationId) return;

      const id = makeId();
      const token = getToken();
      dispatch({ type: "user_message", id, text, files });
      try {
        const response = await fetch(`/api/conversations/${conversationId}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ text, files }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        dispatch({ type: "message_delivery", id, delivery: "accepted" });
      } catch {
        dispatch({ type: "message_delivery", id, delivery: "failed" });
      }
    },
    [state.activeConversationId],
  );

  const resolveApproval = useCallback(
    async (approved: boolean, reason?: string) => {
      // 审批响应通过 HTTP POST 发送
      const pending = state.pendingApproval;
      if (!pending) return;

      const token = getToken();
      try {
        await fetch(`/api/approvals/${pending.gateId}/respond`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ approved, reason }),
        });
        dispatch({ type: "clear_approval" });
      } catch {
        // ignore
      }
    },
    [state.pendingApproval],
  );

  const submitCredential = useCallback(
    async (values: Record<string, string>) => {
      const pending = state.pendingCredential;
      if (!pending) return;
      const token = getToken();
      try {
        await fetch(`/api/credentials/${pending.reqId}/submit`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ values }),
        });
        dispatch({ type: "clear_credential" });
      } catch {
        // ignore
      }
    },
    [state.pendingCredential],
  );

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
  }, []);

  return {
    ...state,
    send,
    resolveApproval,
    submitCredential,
    switchConversation,
    newConversation,
    loadConversations,
    deleteConversation,
  };
}
