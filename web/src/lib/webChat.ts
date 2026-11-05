import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type {
  AgentPermissionMode,
  ChatMessage,
  ConversationSummary,
  PendingApproval,
  PendingQuestion,
  SSEEvent,
} from "../types";
import { apiFetch, getToken } from "./auth";
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

/** GET pending-approval 返回的审批 DTO（后端 getPendingApproval 形态） */
type PendingApprovalDTO = {
  approvalId: string;
  gateId: string;
  title: string;
  summary: string;
  adoptDraft?: PendingApproval["adoptDraft"];
};

/** 审批 DTO → 前端卡片态（切换会话恢复 / SSE 重连重查 / 审批 404 换绑共用） */
function toPendingApproval(approval: PendingApprovalDTO): PendingApproval {
  return {
    respondId: approval.approvalId,
    gateId: approval.gateId,
    title: approval.title,
    summary: approval.summary,
    ...(approval.adoptDraft ? { adoptDraft: approval.adoptDraft } : {}),
  };
}

/** 非 2xx 响应的语义化错误：优先后端 {error} 字段，退回 HTTP 状态码 */
async function responseErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // 非 JSON 体退回状态码
  }
  return `HTTP ${response.status}`;
}

/** 纯结构化事件的 SSE 通道：统一的表驱动监听（chat UE 轮 E5-F 收敛 16 段样板） */
const STRUCTURED_SSE_EVENTS = [
  "text",
  "text_delta",
  "thinking_delta",
  "tool_use",
  "tool_result",
  "activity",
  "approval_card",
  "approval_closed",
  "credential_missing_card",
  "ask_user_question",
  "eviction_notice",
  "conversation_title",
  "queue_depth",
  "result",
  "error",
] as const;

/** 会话回合缓存容量（chat UE 轮 E5-D：切换回来先上缓存再后台刷新，LRU 3 份） */
const TURN_CACHE_LIMIT = 3;

export function useWebChat() {
  const [state, dispatch] = useReducer(chatReducer, undefined, initialChatState);
  const sseRef = useRef<SSEClient | null>(null);
  const messagesRequestRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const persistDraftRef = useRef<Promise<string | null> | null>(null);
  // 会话可选模型（M2 对话选模型）：随会话切换加载；modelRef 为空 = 不指定（走服务端 fallback）
  const [llmOptions, setLlmOptions] = useState<LlmOptionsDTO>({ options: [], current: "" });
  const [modelRef, setModelRef] = useState("");
  // 归档会话视图（chat UE 轮 E1-C）：按需加载，独立于活跃列表
  const [archivedConversations, setArchivedConversations] = useState<ConversationSummary[]>([]);
  // SSE 事件批处理（chat UE 轮 E5-C）：按到达序入队，rAF 合帧 flush（隐藏页 250ms 定时兜底）。
  // 顺序敏感（text/tool 交错构成回合时间线），必须整队按序派发，不能按事件类型分流。
  const wsQueueRef = useRef<SSEEvent[]>([]);
  const wsFlushScheduledRef = useRef(false);
  const reconnectCountRef = useRef(0);
  // 最近会话回合缓存：离开会话时快照、拉取成功时回写、发送/归档时失效
  const turnCacheRef = useRef<Map<string, ChatMessage[]>>(new Map());

  const dispatchWs = useCallback((msg: SSEEvent) => {
    wsQueueRef.current.push(msg);
    if (wsFlushScheduledRef.current) return;
    wsFlushScheduledRef.current = true;
    const flush = () => {
      wsFlushScheduledRef.current = false;
      const batch = wsQueueRef.current;
      wsQueueRef.current = [];
      for (const item of batch) dispatch({ type: "ws", msg: item });
    };
    if (typeof document !== "undefined" && document.hidden) {
      // 后台页：低频合帧即可（渲染不可见，省主线程）
      setTimeout(flush, 250);
    } else if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flush);
    } else {
      flush();
    }
  }, []);

  const cacheTurns = useCallback((conversationId: string, messages: ChatMessage[]) => {
    const cache = turnCacheRef.current;
    cache.delete(conversationId);
    cache.set(conversationId, messages);
    while (cache.size > TURN_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }, []);

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

  /** 加载会话列表（后端 enrich：lastMessagePreview/unreadCount 随条目返回） */
  const loadConversations = useCallback(async () => {
    dispatch({ type: "clear_error", key: "conversations" });
    try {
      const token = getToken();
      const res = await apiFetch(`/api/conversations?userId=${encodeURIComponent(getUserId())}`, {
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

  /** 加载归档会话（归档视图，chat UE 轮 E1-C；失败静默=视图显示空态） */
  const loadArchivedConversations = useCallback(async (): Promise<ConversationSummary[]> => {
    try {
      const token = getToken();
      const res = await apiFetch(
        `/api/conversations?userId=${encodeURIComponent(getUserId())}&archived=1`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list: ConversationSummary[] = await res.json();
      setArchivedConversations(list);
      return list;
    } catch {
      setArchivedConversations([]);
      return [];
    }
  }, [getUserId]);

  /** 重命名会话（chat UE 轮 E1-B）：PATCH title，乐观更新 + 失败回滚 */
  const renameConversation = useCallback(
    async (id: string, title: string): Promise<boolean> => {
      const trimmed = title.trim();
      if (!trimmed) return false;
      const previous = state.conversations.find((c) => c.id === id)?.title;
      dispatch({ type: "update_conversation", conversationId: id, patch: { title: trimmed } });
      try {
        const token = getToken();
        const res = await apiFetch(`/api/conversations/${id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ title: trimmed }),
        });
        if (!res.ok) throw new Error(await responseErrorDetail(res));
        return true;
      } catch (error: unknown) {
        dispatch({
          type: "update_conversation",
          conversationId: id,
          patch: { title: previous ?? "" },
        });
        dispatch({
          type: "set_error",
          key: "conversations",
          message: errorText(error, "重命名失败"),
        });
        return false;
      }
    },
    [state.conversations],
  );

  /** 恢复归档（chat UE 轮 E1-C）：PATCH archived:false + 本地两列表同步。
   *  fallback：归档撤销路径传入的快照（归档视图尚未加载/已从视图移除时使用） */
  const restoreConversation = useCallback(
    async (id: string, fallback?: ConversationSummary): Promise<boolean> => {
      const conversation = archivedConversations.find((c) => c.id === id) ?? fallback;
      if (!conversation) return false;
      try {
        const token = getToken();
        const res = await apiFetch(`/api/conversations/${id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ archived: false }),
        });
        if (!res.ok) throw new Error(await responseErrorDetail(res));
        setArchivedConversations((list) => list.filter((c) => c.id !== id));
        dispatch({ type: "restore_conversation", conversation });
        return true;
      } catch (error: unknown) {
        dispatch({
          type: "set_error",
          key: "conversations",
          message: errorText(error, "恢复失败"),
        });
        return false;
      }
    },
    [archivedConversations],
  );

  /** 标记「已打开会话」（chat UE 轮 E1-A）：后端清未读基准 + 本地徽标即清 */
  const markConversationSeen = useCallback((conversationId: string): void => {
    const token = getToken();
    void apiFetch(`/api/conversations/${conversationId}/seen`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).catch(() => {});
    dispatch({
      type: "update_conversation",
      conversationId,
      patch: { unreadCount: 0, lastSeenAt: new Date().toISOString() },
    });
  }, []);

  /** 重查会话挂起审批（SSE 重连握手 / 审批 404 换绑共用）：有活实例重新锚定，没有则撤下残卡 */
  const refreshPendingApproval = useCallback(async (conversationId: string): Promise<void> => {
    const token = getToken();
    try {
      const response = await apiFetch(`/api/conversations/${conversationId}/pending-approval`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) return;
      const { approval } = (await response.json()) as { approval: PendingApprovalDTO | null };
      dispatch({
        type: "set_pending_approval",
        approval: approval ? toPendingApproval(approval) : null,
      });
    } catch {
      // 尽力而为：查询失败保持现状
    }
  }, []);

  /**
   * 断流重连补拉（热发布 M4 P2a，spec 2026-10-16-hot-deploy-design §7.1）：
   * SSE 重连后断线窗口内的增量事件以 history 为准全量重建（messages+events），
   * 消除「重连成功但中间输出永久丢失」。尽力而为：失败保持现状不断流。
   * 拉取成功同时回写回合缓存（切换闪屏消除的数据源）。
   */
  const refetchHistory = useCallback(
    async (conversationId: string): Promise<void> => {
      const token = getToken();
      const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      try {
        const [messagesRes, events] = await Promise.all([
          apiFetch(`/api/conversations/${conversationId}/messages`, { headers: authHeaders }),
          apiFetch(`/api/conversations/${conversationId}/events?light=1`, { headers: authHeaders })
            .then((response) =>
              response.ok
                ? (response.json() as Promise<{ events: HistoryEvent[] }>)
                : { events: [] },
            )
            .catch(() => ({ events: [] as HistoryEvent[] })),
        ]);
        if (!messagesRes.ok) return;
        const messages = (await messagesRes.json()) as HistoryMessage[];
        const turns = assembleTurnMessages(messages, events.events);
        cacheTurns(conversationId, turns);
        dispatch({ type: "set_messages", messages: turns });
      } catch {
        // 尽力而为：补拉失败保持当前状态（下条事件仍会增量到达）
      }
    },
    [cacheTurns],
  );

  /** 连接 SSE 流 */
  const connectSSE = useCallback(
    (conversationId: string) => {
      // EventSource 无法设置 Authorization 头，改用 ?token= 查询参数鉴权
      const token = getToken();
      const qs = token ? `?token=${encodeURIComponent(token)}` : "";
      const eventSource = new EventSource(`/api/conversations/${conversationId}/stream${qs}`);

      sseRef.current = {
        close: () => eventSource.close(),
      };

      // 结构化事件统一表驱动（data.type 严格等于通道名才派发，与逐段监听时代的守卫一致）
      for (const eventName of STRUCTURED_SSE_EVENTS) {
        eventSource.addEventListener(eventName, (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data) as SSEEvent;
            if (data.type === eventName) {
              dispatchWs(data);
            }
          } catch {
            // ignore
          }
        });
      }

      // 排水广播（热发布优雅停机）：服务更新中，横幅提示；新实例接管后 onopen 会清除
      eventSource.addEventListener("server_draining", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data) as SSEEvent;
          if (data.type === "server_draining") {
            const minutes = data.deadline
              ? Math.max(1, Math.round((data.deadline - Date.now()) / 60_000))
              : 10;
            dispatch({
              type: "set_error",
              key: "stream",
              message: `🚧 服务正在更新发布：进行中的对话将继续完成（约 ${minutes} 分钟内）后切换，新消息请稍候重发`,
            });
          }
        } catch {
          // ignore
        }
      });

      // 断流重连缺口超出服务端缓冲（热发布 M4）：放弃增量、全量补拉重建
      eventSource.addEventListener("stream_resync", () => {
        void refetchHistory(conversationId);
      });

      eventSource.onopen = () => {
        dispatch({ type: "connection", state: "open" });
        dispatch({ type: "clear_error", key: "stream" });
        reconnectCountRef.current = 0;
        dispatch({ type: "set_reconnect_attempts", count: 0 });
        // 重连/重开即重查挂起审批：服务重启清扫后残卡随握手撤下，活审批重新锚定
        void refreshPendingApproval(conversationId);
        // 断流补拉（热发布 M4 P2a）：断线窗口增量以 history 重建
        void refetchHistory(conversationId);
        // 通知 PWA 流已恢复（发布切换后借此自动刷新到新 bundle，不再要求手点）
        window.dispatchEvent(new Event("donger:stream-reconnected"));
      };

      eventSource.onerror = (event) => {
        if (event instanceof MessageEvent && event.data) return;
        reconnectCountRef.current += 1;
        dispatch({ type: "connection", state: "closed" });
        dispatch({ type: "generation", running: false });
        dispatch({ type: "set_reconnect_attempts", count: reconnectCountRef.current });
        dispatch({
          type: "set_error",
          key: "stream",
          message: `连接中断，浏览器正在自动重连（第 ${reconnectCountRef.current} 次）`,
        });
      };

      return eventSource;
    },
    [dispatchWs, refreshPendingApproval, refetchHistory],
  );

  /** 手动重连（chat UE 轮 E5-E）：EventSource 自身自动重连，这里立即补拉 + 撤横幅，不等下一轮重试 */
  const reconnectStream = useCallback(() => {
    const conversationId = state.activeConversationId;
    dispatch({ type: "clear_error", key: "stream" });
    if (
      !conversationId ||
      isDraftConversation(state.conversations.find((c) => c.id === conversationId))
    ) {
      return;
    }
    void refreshPendingApproval(conversationId);
    void refetchHistory(conversationId);
  }, [refreshPendingApproval, refetchHistory, state.activeConversationId, state.conversations]);

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

  /** 切换会话：缓存命中先上屏（消闪）再后台刷新；离开时快照进 LRU */
  const switchConversation = useCallback(
    (conversationId: string | null) => {
      messagesRequestRef.current?.abort();
      dispatch({ type: "clear_error", key: "messages" });
      // 离开前快照当前会话回合（仅非空、非生成中——生成中的回合由 refetch 重建更可靠）
      if (state.activeConversationId && state.messages.length > 0 && !state.isGenerating) {
        cacheTurns(state.activeConversationId, state.messages);
      }
      dispatch({ type: "switch_conversation", conversationId });
      const conversation = state.conversations.find((item) => item.id === conversationId);
      if (!conversationId || isDraftConversation(conversation)) return;
      // 标记已读（chat UE 轮 E1-A）：打开即清未读徽标
      markConversationSeen(conversationId);
      // 缓存命中：先上屏再后台刷新（后台 set_messages 会覆盖为服务端真值）
      const cached = turnCacheRef.current.get(conversationId);
      if (cached && cached.length > 0) {
        dispatch({ type: "set_messages", messages: cached });
      }
      const controller = new AbortController();
      messagesRequestRef.current = controller;
      const token = getToken();
      const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      // 重置模型选择（新会话的选项异步加载后回填）
      setLlmOptions({ options: [], current: "" });
      setModelRef("");
      Promise.all([
        apiFetch(`/api/conversations/${conversationId}/messages`, {
          headers: authHeaders,
          signal: controller.signal,
        }).then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<HistoryMessage[]>;
        }),
        // 工具事件装饰：加载失败（如权限/网络）降级为仅合并不装饰
        apiFetch(`/api/conversations/${conversationId}/events?light=1`, {
          headers: authHeaders,
          signal: controller.signal,
        })
          .then((response) =>
            response.ok ? (response.json() as Promise<{ events: HistoryEvent[] }>) : { events: [] },
          )
          .catch(() => ({ events: [] })),
        // 待作答问题：刷新/切换后恢复锚定卡片（agent 仍在等待作答时）
        apiFetch(`/api/conversations/${conversationId}/pending-question`, {
          headers: authHeaders,
          signal: controller.signal,
        })
          .then((response) =>
            response.ok
              ? (response.json() as Promise<{ question: PendingQuestion | null }>)
              : { question: null },
          )
          .catch(() => ({ question: null })),
        // 挂起审批：刷新/切换后恢复锚定卡片（任务正卡在人工审批门时）
        apiFetch(`/api/conversations/${conversationId}/pending-approval`, {
          headers: authHeaders,
          signal: controller.signal,
        })
          .then((response) =>
            response.ok
              ? (response.json() as Promise<{ approval: PendingApprovalDTO | null }>)
              : { approval: null },
          )
          .catch(() => ({ approval: null })),
        // 可选模型集（agent 范围/用户配置决定）；失败降级为空（隐藏选择器即可，不打断会话）
        apiFetch(`/api/conversations/${conversationId}/llm-options`, {
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
        .then(([messages, { events }, { question }, { approval }, llmOpts]) => {
          if (messagesRequestRef.current === controller) {
            const turns = assembleTurnMessages(messages, events);
            cacheTurns(conversationId, turns);
            dispatch({ type: "set_messages", messages: turns });
            dispatch({ type: "set_pending_question", question: question ?? null });
            dispatch({
              type: "set_pending_approval",
              approval: approval ? toPendingApproval(approval) : null,
            });
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
    [
      cacheTurns,
      markConversationSeen,
      state.activeConversationId,
      state.conversations,
      state.isGenerating,
      state.messages,
    ],
  );

  const persistDraftConversation = useCallback(
    async (draft: ConversationSummary): Promise<string | null> => {
      if (!draft.isDraft) return draft.id;
      if (persistDraftRef.current) return persistDraftRef.current;

      const promise = (async () => {
        try {
          const token = getToken();
          const response = await apiFetch("/api/conversations", {
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

  /** 消息投递（send/retrySend 共用）：503 排水自动重试 3 次 → 失败置 delivery=failed */
  const postMessage = useCallback(
    async (
      conversationId: string,
      payloadObj: { text: string; files?: FileInfo[]; mentions?: Mention[]; modelRef?: string },
      optimisticId: string,
    ): Promise<void> => {
      const token = getToken();
      const payload = JSON.stringify(payloadObj);
      const post = async (attempt: number): Promise<void> => {
        try {
          const response = await apiFetch(`/api/conversations/${conversationId}/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: payload,
          });
          if (response.status === 503) {
            const body = (await response.json().catch(() => ({}))) as {
              draining?: boolean;
              retryAfter?: number;
              error?: string;
            };
            if (body.draining && attempt < 3) {
              dispatch({
                type: "set_error",
                key: "stream",
                message: "🚧 服务正在更新发布，消息将在恢复后自动发送…",
              });
              setTimeout(() => void post(attempt + 1), ((body.retryAfter ?? 5) + 1) * 1000);
              return;
            }
            throw new Error(body.error ?? `HTTP ${response.status}`);
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          dispatch({ type: "message_delivery", id: optimisticId, delivery: "accepted" });
          // 活跃度触达：与后端「消息落库刷新会话 updatedAt」对齐，发消息后该会话实时排到列表最前
          dispatch({
            type: "update_conversation",
            conversationId,
            patch: { updatedAt: new Date().toISOString() },
          });
        } catch {
          dispatch({ type: "message_delivery", id: optimisticId, delivery: "failed" });
        }
      };
      await post(0);
    },
    [],
  );

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
      dispatch({
        type: "user_message",
        id,
        text,
        files,
        // 重试锚点（chat UE 轮 E5-A）：失败后一键原样重发
        sendPayload: { text, files, mentions },
      });
      // 发送即失效该会话回合缓存（历史即将变化，防切换回闪旧内容）
      turnCacheRef.current.delete(conversationId);
      await postMessage(
        conversationId,
        {
          text,
          files,
          ...(mentions && mentions.length > 0 ? { mentions } : {}),
          ...(modelRef ? { modelRef } : {}),
        },
        id,
      );
    },
    [
      modelRef,
      newConversation,
      persistDraftConversation,
      postMessage,
      state.activeConversationId,
      state.conversations,
    ],
  );

  /** 失败消息一键重发（chat UE 轮 E5-A）：同气泡翻回「发送中」，原载荷重投 */
  const retryMessage = useCallback(
    async (id: string): Promise<void> => {
      const message = state.messages.find((m) => m.id === id);
      if (!message?.sendPayload) return;
      const active = state.conversations.find((item) => item.id === state.activeConversationId);
      const conversationId = active ? await persistDraftConversation(active) : null;
      if (!conversationId) {
        dispatch({ type: "set_error", key: "messages", message: "会话保存失败，请重试" });
        return;
      }
      dispatch({ type: "message_delivery", id, delivery: "sending" });
      const { text, files, mentions } = message.sendPayload;
      // sendPayload.mentions 在 types 里保持无依赖的 unknown[]（避免 types→lib 循环），此处还原类型
      const typedMentions = (mentions ?? undefined) as Mention[] | undefined;
      await postMessage(
        conversationId,
        {
          text,
          files,
          ...(typedMentions && typedMentions.length > 0 ? { mentions: typedMentions } : {}),
          ...(modelRef ? { modelRef } : {}),
        },
        id,
      );
    },
    [
      modelRef,
      persistDraftConversation,
      postMessage,
      state.activeConversationId,
      state.conversations,
      state.messages,
    ],
  );

  const cancel = useCallback(async () => {
    const conversationId = state.activeConversationId;
    const active = state.conversations.find((item) => item.id === conversationId);
    if (!conversationId || isDraftConversation(active)) return;
    const token = getToken();
    const response = await apiFetch(`/api/conversations/${conversationId}/cancel`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok && response.status !== 409) throw new Error(`HTTP ${response.status}`);
    dispatch({ type: "generation", running: false });
  }, [state.activeConversationId, state.conversations]);

  const resolveApproval = useCallback(
    async (approved: boolean, reason?: string, adoptPrefix?: string) => {
      // 审批响应通过 HTTP POST 发送
      const pending = state.pendingApproval;
      const conversationId = state.activeConversationId;
      if (!pending) return;

      const token = getToken();
      dispatch({ type: "clear_error", key: "approval" });
      try {
        const response = await apiFetch(`/api/approvals/${pending.respondId}/respond`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            approved,
            reason,
            ...(approved && adoptPrefix ? { adoptPrefix } : {}),
          }),
        });
        if (!response.ok) {
          // 404 = 审批实例已消亡（任务中断/他端已决议/重启清扫）的死卡：重查换绑而不是裸报错
          if (response.status === 404 && conversationId) {
            await refreshPendingApproval(conversationId);
            dispatch({
              type: "set_error",
              key: "stream",
              message: "该审批已失效（任务可能已被停止或服务重启），已刷新审批状态",
            });
            return;
          }
          throw new Error(await responseErrorDetail(response));
        }
        dispatch({ type: "clear_approval" });
      } catch (error: unknown) {
        dispatch({
          type: "set_error",
          key: "approval",
          message: errorText(error, "审批提交失败"),
        });
      }
    },
    [refreshPendingApproval, state.activeConversationId, state.pendingApproval],
  );

  const decideCredentialMissing = useCallback(
    async (decision: string) => {
      const pending = state.pendingCredential;
      if (!pending) return;
      const token = getToken();
      dispatch({ type: "clear_error", key: "credential" });
      try {
        const response = await apiFetch(`/api/credential-missing/${pending.reqId}/decide`, {
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
        const res = await apiFetch(`/api/user-inputs/${pending.reqId}/respond`, {
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

  /** 归档会话（软删除）。确认交互由组件层 ConfirmDialog 负责；同步清回合缓存与归档视图缓存 */
  const deleteConversation = useCallback(
    async (id: string) => {
      try {
        const conversation = state.conversations.find((item) => item.id === id);
        if (!isDraftConversation(conversation)) {
          const token = getToken();
          await apiFetch(`/api/conversations/${id}`, {
            method: "DELETE",
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
        }
        turnCacheRef.current.delete(id);
        setArchivedConversations((list) => list.filter((c) => c.id !== id));
        dispatch({ type: "remove_conversation", conversationId: id });
      } catch {
        /* 忽略 */
      }
    },
    [state.conversations],
  );

  /** 会话分叉（specs/2026-10-23-conversation-fork-design.md §7/§8）：messageId 缺省=整会话，
   *  给出时恒为「含此条」；成功后新会话插入列表并切换（fork_created）。失败落 errors.conversations */
  const forkConversation = useCallback(
    async (conversationId: string, messageId?: string): Promise<boolean> => {
      dispatch({ type: "clear_error", key: "conversations" });
      try {
        const token = getToken();
        const res = await apiFetch(`/api/conversations/${conversationId}/fork`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(messageId ? { messageId } : {}),
        });
        const data = (await res.json().catch(() => ({}))) as {
          conversation?: ConversationSummary;
          error?: string;
        };
        if (!res.ok || !data.conversation) {
          dispatch({
            type: "set_error",
            key: "conversations",
            message: data.error ?? `分叉失败（HTTP ${res.status}）`,
          });
          return false;
        }
        dispatch({ type: "fork_created", conversation: data.conversation });
        return true;
      } catch (error: unknown) {
        dispatch({
          type: "set_error",
          key: "conversations",
          message: errorText(error, "分叉失败"),
        });
        return false;
      }
    },
    [],
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
    retryMessage,
    cancel,
    resolveApproval,
    decideCredentialMissing,
    answerQuestion,
    switchConversation,
    newConversation,
    ensureConversation,
    loadConversations,
    loadArchivedConversations,
    archivedConversations,
    renameConversation,
    restoreConversation,
    markConversationSeen,
    deleteConversation,
    forkConversation,
    setPermissionMode,
    reconnectStream,
    llmOptions,
    modelRef,
    setModelRef,
  };
}
