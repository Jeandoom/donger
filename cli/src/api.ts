import type { AgentSummary, ConversationSummary, UserSummary } from "./types.js";

export type ApiErrorKind = "network" | "auth" | "server" | "client";

/** 按状态码分类错误（401/403=认证，5xx=服务端，其余=客户端参数） */
export function errorKind(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server";
  return "client";
}

/** 后端返回错误。kind 用于终端分色与引导（auth → 提示重新登录） */
export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface MessageItem {
  id: string;
  role: string;
  text: string;
}

/** 后端 HTTP 客户端：统一 Bearer 头与 JSON 解析。 */
export interface DongerApi {
  /** CLI 共享密钥换 JWT */
  exchange(secret: string): Promise<{ token: string; user: UserSummary }>;
  me(): Promise<{ user: UserSummary }>;
  listAgents(): Promise<AgentSummary[]>;
  /** get-or-create 该 agent 的会话，返回 conversationId */
  agentConversation(agentId: string): Promise<string>;
  createConversation(userId: string, agentId?: string): Promise<ConversationSummary>;
  listConversations(userId: string): Promise<ConversationSummary[]>;
  history(conversationId: string): Promise<MessageItem[]>;
  sendMessage(conversationId: string, text: string): Promise<void>;
  cancel(conversationId: string): Promise<void>;
  respondApproval(gateId: string, approved: boolean, reason?: string): Promise<void>;
  submitCredential(reqId: string, values: Record<string, string>): Promise<void>;
  /** 管理命令通用调用：返回解析后的 JSON（无类型约束，命令层自行取字段） */
  call(method: string, path: string, body?: unknown): Promise<unknown>;
}

export function createApi(baseUrl: string, token: string): DongerApi {
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    expectStatus?: number,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      // Node fetch 把 TLS/DNS 等真实原因藏在 cause 里，剥出来给终端
      const cause = (e as { cause?: unknown })?.cause;
      const detail = cause instanceof Error ? `（${cause.message}）` : "";
      throw new ApiError("network", 0, `无法连接 ${baseUrl}${detail}`);
    }
    if (expectStatus && res.status === expectStatus) {
      return undefined as T;
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON 响应体，仅按状态码处理 */
    }
    if (!res.ok) {
      const msg =
        (data as { error?: string; message?: string } | null)?.error ??
        (data as { message?: string } | null)?.message ??
        `${res.status} ${res.statusText}`;
      throw new ApiError(errorKind(res.status), res.status, msg);
    }
    return data as T;
  }

  return {
    exchange: (secret) => request("POST", "/api/auth/exchange", { token: secret }),
    me: () => request("GET", "/api/auth/me"),
    listAgents: () => request<AgentSummary[]>("GET", "/api/agents"),
    agentConversation: async (agentId) => {
      const r = await request<{ id: string }>("GET", `/api/agents/${agentId}/conversation`);
      return r.id;
    },
    createConversation: (userId, agentId) =>
      request("POST", "/api/conversations", { userId, channelId: "cli", agentId }),
    listConversations: (userId) =>
      request("GET", `/api/conversations?userId=${encodeURIComponent(userId)}`),
    history: (conversationId) =>
      request("GET", `/api/conversations/${conversationId}/messages`),
    sendMessage: (conversationId, text) =>
      request("POST", `/api/conversations/${conversationId}/messages`, { text }),
    cancel: (conversationId) =>
      request("POST", `/api/conversations/${conversationId}/cancel`, {}, 200),
    respondApproval: (gateId, approved, reason) =>
      request("POST", `/api/approvals/${gateId}/respond`, { approved, reason }),
    submitCredential: (reqId, values) =>
      request("POST", `/api/credentials/${reqId}/submit`, { values }),
    call: (method, path, body) => request(method, path, body),
  };
}
