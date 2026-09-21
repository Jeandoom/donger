import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { AgentPermissionMode, ConversationSummary, PendingQuestion, SSEEvent } from "../types";
import { getToken } from "./auth";
import type { FileInfo } from "./chatReducer";
import { chatReducer, initialChatState, isDraftConversation, makeId } from "./chatReducer";
import { setConversationPermissionMode } from "./conversations";
import type { LlmOptionsDTO } from "./llmProviders";
import type { Mention } from "./mentions";
import { assembleTurnMessages, type HistoryEvent, type HistoryMessage } from "./turnAssembly";

type SSEClient = {
  close(): void;
};

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function useWebChat() {
  const [state, dispatch] = useReducer(chatReducer, undefined, initialChatState);
  const sseRef = useRef<SSEClient | null>(null);
  const messagesRequestRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const persistDraftRef = useRef<Promise<string | null> | null>(null);
  // 会话可选模型（M2 对话选模型）：随会话切换加载；modelRef 为空 = 不指定（走服务端 fallback）
  const [llmOptions, setLlmOptions] = useState<LlmOptionsDTO>({ options: [], current: "" });
  const [modelRef, setModelRef] = useState("");

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

  /** 创建新会话（agentId 缺省=默认会话；defaultPermissionMode=绑定智能体的默认对话模式，仅 UI 预填） */
  const newConversation = useCallback(
    async (
      agentId?: string,
      defaultPermissionMode?: AgentPermissionMode,
    ): Promise<ConversationSummary> => {
      const now = new Date().toISOString();
      const conversation: ConversationSummary = {
        id: `draft-${makeId()}`,
        userId: getUserId(),
        sdkSessionId: "",
        title: "新会话",
        channelId: "web",
        agentId: agentId ?? "",
        // 仅预填展示值：permissionMode 保持空 = 跟随智能体默认，与转正后后端计算一致
        effectivePermissionMode: defaultPermissionMode ?? "ask_before_change",
        createdAt: now,
        updatedAt: now,
        archived: false,
        isDraft: true,
      };
      dispatch({ type: "new_conversation", conversation });
      return conversation;
    },
    [getUserId],
  );

  /** 加载会话列表 */
  const loadConversations = useCallback(async () => {
    dispatch({ type: "clear_error", key: "conversations" });
    try {
      const token = getToken();
      const res = await fetch(`/api/conversations?userId=${encodeURIComponent(getUserId())}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list: ConversationSummary[] = await res.json();
      dispatch({ type: "set_conversations", conversations: list });
    } catch (error: unknown) {
      dispatch({
        type: "set_error",
        key: "conversations",
        message: errorText(error, "会话列表加载失败"),
      });
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

    eventSource.addEventListener("text_delta", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEEvent;
        if (data.type === "text_delta") {
          dispatch({ type: "ws", msg: data });
        }
      } catch {
        // ignore
      }
    });

    eventSource.addEventListener("thinking_delta", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEEvent;
        if (data.type === "thinking_delta") {
          dispatch({ type: "ws", msg: data });
        }
      } catch {
        // ignore
      }
    });

    eventSource.addEventListener("tool_use", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEEvent;
        if (data.type === "tool_use") {
          dispatch({ type: "ws", msg: data });
        }
      } catch {
        // ignore
      }
    });

    eventSource.addEventListener("tool_result", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEEvent;
        if (data.type === "tool_result") {
          dispatch({ type: "ws", msg: data });
        }
      } catch {
        // ignore
      }
    });

    eventSource.addEventListener("activity", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEEvent;
        if (data.type === "activity") {
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

    eventSource.addEventListener("credential_missing_card", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEEvent;
        if (data.type === "credential_missing_card") {
          dispatch({ type: "ws", msg: data });
        }
      } catch {
        // ignore
      }
    });

    eventSource.addEventListener("ask_user_question", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEEvent;
        if (data.type === "ask_user_question") {
          dispatch({ type: "ws", msg: data });
        }
      } catch {
        // ignore
      }
    });

    eventSource.addEventListener("eviction_notice", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEEvent;
        if (data.type === "eviction_notice") {
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
          dispatch({ type: "ws", msg: data });
        }
      } catch {
        // ignore
      }
      // EventSource 会自动重连，无需手动处理
    });

    eventSource.onopen = () => {
      dispatch({ type: "connection", state: "open" });
      dispatch({ type: "clear_error", key: "stream" });
    };

    eventSource.onerror = (event) => {
      if (event instanceof MessageEvent && event.data) return;
      dispatch({ type: "connection", state: "closed" });
      dispatch({ type: "generation", running: false });
      dispatch({
        type: "set_error",
        key: "stream",
        message: "连接中断，浏览器正在自动重连",
      });
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
    const activeConversation = state.conversations.find(
      (conversation) => conversation.id === state.activeConversationId,
    );
    if (isDraftConversation(activeConversation)) return;

    const eventSource = connectSSE(state.activeConversationId);

    return () => {
      eventSource.close();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, [state.activeConversationId, state.conversations, connectSSE]);

  useEffect(() => () => messagesRequestRef.current?.abort(), []);

  /** 切换会话（先清空本地消息，再异步加载历史消息） */
  const switchConversation = useCallback(
    (conversationId: string | null) => {
      messagesRequestRef.current?.abort();
      dispatch({ type: "clear_error", key: "messages" });
      dispatch({ type: "switch_conversation", conversationId });
      const conversation = state.conversations.find((item) => item.id === conversationId);
      if (!conversationId || isDraftConversation(conversation)) return;
      const controller = new AbortController();
      messagesRequestRef.current = controller;
      const token = getToken();
      const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      // 重置模型选择（新会话的选项异步加载后回填）
      setLlmOptions({ options: [], current: "" });
      setModelRef("");
      Promise.all([
        fetch(`/api/conversations/${conversationId}/messages`, {
          headers: authHeaders,
          signal: controller.signal,
        }).then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<HistoryMessage[]>;
        }),
        // 工具事件装饰：加载失败（如权限/网络）降级为仅合并不装饰
        fetch(`/api/conversations/${conversationId}/events?light=1`, {
          headers: authHeaders,
          signal: controller.signal,
        })
          .then((response) =>
            response.ok ? (response.json() as Promise<{ events: HistoryEvent[] }>) : { events: [] },
          )
          .catch(() => ({ events: [] })),
        // 待作答问题：刷新/切换后恢复锚定卡片（agent 仍在等待作答时）
        fetch(`/api/conversations/${conversationId}/pending-question`, {
          headers: authHeaders,
          signal: controller.signal,
        })
          .then((response) =>
            response.ok
              ? (response.json() as Promise<{ question: PendingQuestion | null }>)
              : { question: null },
          )
          .catch(() => ({ question: null })),
        // 可选模型集（agent 范围/用户配置决定）；失败降级为空（隐藏选择器即可，不打断会话）
        fetch(`/api/conversations/${conversationId}/llm-options`, {
          headers: authHeaders,
          signal: controller.signal,
        })
          .then((response) =>
            response.ok
              ? (response.json() as Promise<LlmOptionsDTO>)
              : { options: [], current: "" },
          )
          .catch(() => ({ options: [], current: "" })),
      ])
        .then(([messages, { events }, { question }, llmOpts]) => {
          if (messagesRequestRef.current === controller) {
            dispatch({ type: "set_messages", messages: assembleTurnMessages(messages, events) });
            dispatch({ type: "set_pending_question", question: question ?? null });
            setLlmOptions(llmOpts);
            // 恢复上次选择；不在当前可选集（配置已变）则回落首项
            const restored =
              llmOpts.current && llmOpts.options.some((o) => o.ref === llmOpts.current)
                ? llmOpts.current
                : (llmOpts.options[0]?.ref ?? "");
            setModelRef(restored);
          }
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (messagesRequestRef.current === controller) {
            dispatch({
              type: "set_error",
              key: "messages",
              message: errorText(error, "历史消息加载失败"),
            });
            dispatch({ type: "set_messages", messages: [] });
          }
        })
        .finally(() => {
          if (messagesRequestRef.current === controller) messagesRequestRef.current = null;
        });
    },
    [state.conversations],
  );

  const persistDraftConversation = useCallback(
    async (draft: ConversationSummary): Promise<string | null> => {
      if (!draft.isDraft) return draft.id;
      if (persistDraftRef.current) return persistDraftRef.current;

      const promise = (async () => {
        try {
          const token = getToken();
          const response = await fetch("/api/conversations", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
              userId: draft.userId,
              channelId: draft.channelId,
              agentId: draft.agentId || undefined,
            }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const conversation = (await response.json()) as ConversationSummary;
          dispatch({ type: "persist_conversation", draftId: draft.id, conversation });
          return conversation.id;
        } catch {
          return null;
        }
      })();
      persistDraftRef.current = promise;
      void promise.finally(() => {
        if (persistDraftRef.current === promise) persistDraftRef.current = null;
      });
      return promise;
    },
    [],
  );

  const ensureConversation = useCallback(async (): Promise<string | null> => {
    const active = state.conversations.find((item) => item.id === state.activeConversationId);
    if (!active) return null;
    return persistDraftConversation(active);
  }, [persistDraftConversation, state.activeConversationId, state.conversations]);

  const send = useCallback(
    async (text: string, files?: FileInfo[], mentions?: Mention[]): Promise<void> => {
      let active = state.conversations.find((item) => item.id === state.activeConversationId);
      if (!active) {
        // 初始空态（尚未选中任何会话）直接发送：先落一个草稿，避免消息被静默丢弃
        active = await newConversation();
      }
      const conversationId = await persistDraftConversation(active);
      if (!conversationId) {
        dispatch({ type: "set_error", key: "messages", message: "会话保存失败，请重试" });
        return;
      }

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
          body: JSON.stringify({
            text,
            files,
            ...(mentions && mentions.length > 0 ? { mentions } : {}),
            ...(modelRef ? { modelRef } : {}),
          }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        dispatch({ type: "message_delivery", id, delivery: "accepted" });
      } catch {
        dispatch({ type: "message_delivery", id, delivery: "failed" });
      }
    },
    [
      modelRef,
      newConversation,
      persistDraftConversation,
      state.activeConversationId,
      state.conversations,
    ],
  );

  const cancel = useCallback(async () => {
    const conversationId = state.activeConversationId;
    const active = state.conversations.find((item) => item.id === conversationId);
    if (!conversationId || isDraftConversation(active)) return;
    const token = getToken();
    const response = await fetch(`/api/conversations/${conversationId}/cancel`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok && response.status !== 409) throw new Error(`HTTP ${response.status}`);
    dispatch({ type: "generation", running: false });
  }, [state.activeConversationId, state.conversations]);

  const resolveApproval = useCallback(
    async (approved: boolean, reason?: string) => {
      // 审批响应通过 HTTP POST 发送
      const pending = state.pendingApproval;
      if (!pending) return;

      const token = getToken();
      dispatch({ type: "clear_error", key: "approval" });
      try {
        const response = await fetch(`/api/approvals/${pending.gateId}/respond`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ approved, reason }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        dispatch({ type: "clear_approval" });
      } catch (error: unknown) {
        dispatch({
          type: "set_error",
          key: "approval",
          message: errorText(error, "审批提交失败"),
        });
      }
    },
    [state.pendingApproval],
  );

  const decideCredentialMissing = useCallback(
    async (decision: string) => {
      const pending = state.pendingCredential;
      if (!pending) return;
      const token = getToken();
      dispatch({ type: "clear_error", key: "credential" });
      try {
        const response = await fetch(`/api/credential-missing/${pending.reqId}/decide`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ decision }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        dispatch({ type: "clear_credential" });
      } catch (error: unknown) {
        dispatch({
          type: "set_error",
          key: "credential",
          message: errorText(error, "凭证问询提交失败"),
        });
      }
    },
    [state.pendingCredential],
  );

  /** AskUserQuestion 作答：answers key=问题原文；提交后由后端 resolve 挂起的问询 */
  const answerQuestion = useCallback(
    async (answers: Record<string, string>, response?: string) => {
      const pending = state.pendingQuestion;
      if (!pending) return;
      const token = getToken();
      dispatch({ type: "clear_error", key: "question" });
      try {
        const res = await fetch(`/api/user-inputs/${pending.reqId}/respond`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ answers, ...(response?.trim() ? { response } : {}) }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        dispatch({ type: "clear_question" });
      } catch (error: unknown) {
        dispatch({
          type: "set_error",
          key: "question",
          message: errorText(error, "作答提交失败"),
        });
      }
    },
    [state.pendingQuestion],
  );

  /** 删除会话（软删除，归档）。确认交互由组件层 ConfirmDialog 负责 */
  const deleteConversation = useCallback(
    async (id: string) => {
      try {
        const conversation = state.conversations.find((item) => item.id === id);
        if (!isDraftConversation(conversation)) {
          const token = getToken();
          await fetch(`/api/conversations/${id}`, {
            method: "DELETE",
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
        }
        dispatch({ type: "remove_conversation", conversationId: id });
      } catch {
        /* 忽略 */
      }
    },
    [state.conversations],
  );

  /** 切换会话权限模式：草稿先落库转正 → PATCH 落库 + 本地乐观更新（失败回滚并提示） */
  const setPermissionMode = useCallback(
    async (mode: AgentPermissionMode) => {
      const active = state.conversations.find((item) => item.id === state.activeConversationId);
      if (!active) return;
      // 草稿会话先转正：否则 PATCH 无目标，设置随草稿一并丢失（转正失败静默返回，发送时会重试）
      const conversationId = await persistDraftConversation(active);
      if (!conversationId) return;
      const previous = active.permissionMode;
      const previousEffective = active.effectivePermissionMode;
      dispatch({
        type: "update_conversation",
        conversationId,
        // UI 优先读 effectivePermissionMode（列表接口恒返回），乐观更新须一并改写
        patch: { permissionMode: mode, effectivePermissionMode: mode },
      });
      try {
        await setConversationPermissionMode(conversationId, mode);
      } catch {
        dispatch({
          type: "update_conversation",
          conversationId,
          patch: { permissionMode: previous, effectivePermissionMode: previousEffective },
        });
        dispatch({
          type: "set_error",
          key: "conversations",
          message: "权限模式切换失败，已还原",
        });
      }
    },
    [persistDraftConversation, state.activeConversationId, state.conversations],
  );

  const dismissEviction = useCallback(() => dispatch({ type: "clear_eviction" }), []);

  return {
    ...state,
    dismissEviction,
    send,
    cancel,
    resolveApproval,
    decideCredentialMissing,
    answerQuestion,
    switchConversation,
    newConversation,
    ensureConversation,
    loadConversations,
    deleteConversation,
    setPermissionMode,
    llmOptions,
    modelRef,
    setModelRef,
  };
}
