import type { AgentSummary, ConversationSummary, UserSummary } from "./types.js";

/** 后端返回非 2xx 时抛出（message 取 body.error） */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
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
  sendMessage(conversationId: string, text: string): Promise<void>;
  cancel(conversationId: string): Promise<void>;
  respondApproval(gateId: string, approved: boolean, reason?: string): Promise<void>;
  submitCredential(reqId: string, values: Record<string, string>): Promise<void>;
}

export function createApi(baseUrl: string, token: string): DongerApi {
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    expectStatus?: number,
  ): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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
      throw new ApiError(res.status, msg);
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
    sendMessage: (conversationId, text) =>
      request("POST", `/api/conversations/${conversationId}/messages`, { text }),
    cancel: (conversationId) =>
      request("POST", `/api/conversations/${conversationId}/cancel`, {}, 200),
    respondApproval: (gateId, approved, reason) =>
      request("POST", `/api/approvals/${gateId}/respond`, { approved, reason }),
    submitCredential: (reqId, values) =>
      request("POST", `/api/credentials/${reqId}/submit`, { values }),
  };
}
