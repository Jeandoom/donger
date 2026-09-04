import { readFileSync } from "node:fs";
import { basename } from "node:path";
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
  sendMessage(conversationId: string, text: string, files?: AttachmentFile[]): Promise<void>;
  /** 上传附件（图片/md，≤2MB），返回 {path,name,type} 供 sendMessage 携带 */
  upload(conversationId: string, filePath: string): Promise<AttachmentFile>;
  cancel(conversationId: string): Promise<void>;
  respondApproval(gateId: string, approved: boolean, reason?: string): Promise<void>;
  submitCredential(reqId: string, values: Record<string, string>): Promise<void>;
  /** 管理命令通用调用：返回解析后的 JSON（无类型约束，命令层自行取字段） */
  call(method: string, path: string, body?: unknown): Promise<unknown>;
}

export interface AttachmentFile {
  path: string;
  name: string;
  type: "image" | "markdown";
}

const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};
const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

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
      const hint = token ? "" : "。若后端非默认地址，用 --url <url> 或 DONGER_URL 指定";
      throw new ApiError("network", 0, `无法连接 ${baseUrl}${detail}${hint}`);
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
    history: (conversationId) => request("GET", `/api/conversations/${conversationId}/messages`),
    sendMessage: (conversationId, text, files) =>
      request(
        "POST",
        `/api/conversations/${conversationId}/messages`,
        files ? { text, files } : { text },
      ),
    upload: async (conversationId, filePath) => {
      const name = basename(filePath);
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      const type = ext in IMAGE_MIME ? "image" : ext === "md" ? "markdown" : null;
      if (!type)
        throw new ApiError(
          "client",
          0,
          `仅支持图片(.jpg/.png/.gif/.webp)与 Markdown(.md)，但"${name}"的扩展名是"${ext}"`,
        );
      let buf: Buffer;
      try {
        buf = readFileSync(filePath);
      } catch {
        throw new ApiError("client", 0, `无法读取文件：${filePath}（不存在或不可访问）`);
      }
      if (buf.length > UPLOAD_MAX_BYTES) {
        throw new ApiError("client", 0, `文件超过 2MB 上限（${Math.round(buf.length / 1024)}KB）`);
      }
      const fd = new FormData();
      // 后端按 mimeType 判定图片类型，Blob 必须带 type（md 仅看扩展名，也一并补上）
      const mime =
        type === "image" ? (IMAGE_MIME[ext] ?? "application/octet-stream") : "text/markdown";
      fd.append("file", new Blob([new Uint8Array(buf)], { type: mime }), name);
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/upload?threadId=${encodeURIComponent(conversationId)}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        });
      } catch (e) {
        const cause = (e as { cause?: unknown })?.cause;
        throw new ApiError(
          "network",
          0,
          `上传失败：无法连接 ${baseUrl}${cause instanceof Error ? `（${cause.message}）` : ""}`,
        );
      }
      const body = (await res.json().catch(() => null)) as {
        path?: string;
        name?: string;
        type?: string;
        error?: string;
      } | null;
      if (!res.ok || !body?.path) {
        throw new ApiError(
          errorKind(res.status),
          res.status,
          body?.error ?? `上传失败：${res.status}`,
        );
      }
      return { path: body.path, name: body.name ?? name, type: type };
    },
    cancel: (conversationId) =>
      request("POST", `/api/conversations/${conversationId}/cancel`, {}, 200),
    respondApproval: (gateId, approved, reason) =>
      request("POST", `/api/approvals/${gateId}/respond`, { approved, reason }),
    submitCredential: (reqId, values) =>
      request("POST", `/api/credentials/${reqId}/submit`, { values }),
    call: (method, path, body) => request(method, path, body),
  };
}
