import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage as HttpRequest,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Busboy from "busboy";
import { mimeForExt } from "../domain/file-mime.js";
import type { ApprovalCard, IncomingMessage, OutgoingMessage } from "../domain/types.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { AuditStore } from "../ports/audit-store.js";
import type { Channel } from "../ports/channel.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import type { FileBrowser } from "../ports/file-browser.js";
import type { MessageStore } from "../ports/message-store.js";
import type { SessionStore } from "../ports/session-store.js";
import type { TaskStore } from "../ports/task-store.js";
import type { UsageStore } from "../ports/usage-store.js";
import type { UserStore } from "../ports/user-store.js";
import { ForbiddenError, NotFoundError, PayloadTooLargeError } from "../util/errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type StaticTarget = { kind: "file"; absPath: string } | null;

/**
 * 决定静态文件如何托管（纯函数，便于单测）。
 * 仅当 web/dist 存在时托管：/ 与未知路径 → dist/index.html（SPA fallback）；
 * /assets/ 下真实文件直返，缺失 → null；无 dist → null。
 */
export function resolveStaticFile(webRoot: string, urlPath: string): StaticTarget {
  const distRoot = join(webRoot, "dist");
  if (!existsSync(distRoot)) return null;

  if (urlPath === "/" || urlPath === "/index.html") {
    return { kind: "file", absPath: join(distRoot, "index.html") };
  }
  if (urlPath.startsWith("/assets/")) {
    const candidate = join(distRoot, urlPath);
    return existsSync(candidate) ? { kind: "file", absPath: candidate } : null;
  }
  return { kind: "file", absPath: join(distRoot, "index.html") };
}

function contentType(absPath: string): string {
  if (absPath.endsWith(".html")) return "text/html; charset=utf-8";
  if (absPath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (absPath.endsWith(".css")) return "text/css; charset=utf-8";
  if (absPath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

/** SSE 事件类型 */
type SSEEvent =
  | { type: "text"; text: string }
  | { type: "approval_card"; gateId: string; title: string; summary: string }
  | { type: "result"; subtype: "success" | "error"; text: string }
  | { type: "error"; error: string };

/** 向 SSE 客户端写事件的回调 */
type SSEClient = {
  write(event: SSEEvent): void;
  close(): void;
};

export interface WebChannelDeps {
  port: number;
  /** 监听地址（默认 0.0.0.0=全网卡；设 127.0.0.1 仅本机） */
  host?: string;
  /** 上传文件保存根目录 */
  workspaceDir: string;
  taskStore?: TaskStore;
  userStore?: UserStore;
  conversationStore?: ConversationStore;
  messageStore?: MessageStore;
  usageStore?: UsageStore;
  auditStore?: AuditStore;
  sessionStore?: SessionStore;
  fileBrowser?: FileBrowser;
  dingtalkConfig?: { appKey: string; appSecret: string };
  /** web 前端根目录（默认 <repo>/web）；测试可指向临时目录 */
  webRoot?: string;
}

/**
 * WebChannel（SSE 版本）
 *
 * 通信模式：
 *   Client → Server：HTTP POST 发送消息、审批响应
 *   Server → Client：SSE（EventSource）流式推送回复、审批请求
 *
 * 废弃 WebSocket，全部改用 HTTP + SSE：
 *   - 用户发消息：POST /api/conversations/:id/messages
 *   - 流式接收回复：GET /api/conversations/:id/stream (SSE)
 *   - 审批请求推送：GET /api/approvals/stream (SSE)
 *   - 审批响应：POST /api/approvals/:id/respond
 */
export class WebChannel implements Channel {
  readonly id = "web";
  readonly streaming = true;
  private handler?: (msg: IncomingMessage) => void;
  private server?: Server;
  private readyPromise?: Promise<void>;
  /** 会话 ID → SSE 客户端集合 */
  private readonly sseClients = new Map<string, Set<SSEClient>>();
  /** 审批 ID → SSE 客户端（审批请求推送） */
  private readonly approvalStreams = new Map<string, SSEClient>();
  private nextId = 0;
  private readonly webRoot: string;
  private readonly workspaceDir: string;
  private readonly messageStore?: MessageStore;
  private readonly sessionStore?: SessionStore;
  private readonly fileBrowser?: FileBrowser;
  private readonly dingtalkConfig?: { appKey: string; appSecret: string };
  private readonly oauthStateMap = new Map<string, number>();

  constructor(private readonly deps: WebChannelDeps) {
    this.webRoot = deps.webRoot ?? join(__dirname, "..", "..", "web");
    this.workspaceDir = deps.workspaceDir;
    this.messageStore = deps.messageStore;
    this.sessionStore = deps.sessionStore;
    this.fileBrowser = deps.fileBrowser;
    this.dingtalkConfig = deps.dingtalkConfig;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;

    const server = createServer((req, res) => this.handleHttp(req, res));
    this.server = server;
    this.readyPromise = new Promise<void>((resolve) => {
      server.listen(this.deps.port, this.deps.host ?? "0.0.0.0", () => resolve());
    });
  }

  // ---------------------------------------------------------------------------
  // SSE 推送方法
  // ---------------------------------------------------------------------------

  /** 向会话的 SSE 客户端推送文本消息 */
  pushText(conversationId: string, text: string): void {
    this.broadcastToConversation(conversationId, { type: "text", text });
  }

  /** 向会话的 SSE 客户端推送完成通知 */
  pushResult(conversationId: string, subtype: "success" | "error", text: string): void {
    this.broadcastToConversation(conversationId, { type: "result", subtype, text });
  }

  /** 推送审批卡片（SSE） */
  pushApprovalCard(
    conversationId: string,
    gateId: string,
    title: string,
    summary: string,
  ): Promise<void> {
    // 审批卡片通过 SSE 推送给对应会话
    this.broadcastToConversation(conversationId, { type: "approval_card", gateId, title, summary });
    return Promise.resolve();
  }

  /** 等待审批响应（通过 HTTP POST /api/approvals/:id/respond） */
  async requestApproval(
    threadId: string,
    card: ApprovalCard,
  ): Promise<{ approved: boolean; reason?: string }> {
    // 通过 SSE 广播审批请求，客户端通过 HTTP POST 响应
    return new Promise((resolve, reject) => {
      this.approvalStreams.set(card.gateId, {
        write: (_event: SSEEvent) => {},
        close: () => {},
      });

      // 设置超时：60 秒未响应则取消
      const timeout = setTimeout(() => {
        this.approvalStreams.delete(card.gateId);
        reject(new Error("审批超时（60秒）"));
      }, 60_000);

      // 注意：实际的审批响应通过 HTTP POST /api/approvals/:id/respond 处理
      // 这里返回一个占位 Promise，实际响应由 HTTP 处理器调用 resolve
      this.pendingApprovalResolves.set(card.gateId, (result) => {
        clearTimeout(timeout);
        this.approvalStreams.delete(card.gateId);
        resolve(result);
      });
    });
  }

  /** 存储审批响应的 resolve 函数 */
  private readonly pendingApprovalResolves = new Map<
    string,
    (result: { approved: boolean; reason?: string }) => void
  >();

  /** 向特定会话广播事件 */
  private broadcastToConversation(conversationId: string, event: SSEEvent): void {
    const clients = this.sseClients.get(conversationId);
    if (!clients) return;
    for (const client of clients) {
      try {
        client.write(event);
      } catch {
        // 客户端可能已断开，忽略错误
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Channel 接口实现
  // ---------------------------------------------------------------------------

  async send(threadId: string, _msg: OutgoingMessage): Promise<void> {
    // SSE 版本：send 由 pushText/pushResult 替代
    void threadId;
    void _msg;
  }

  // ---------------------------------------------------------------------------
  // SSE 流管理
  // ---------------------------------------------------------------------------

  /** 注册 SSE 客户端到会话 */
  subscribeSSE(conversationId: string, client: SSEClient): void {
    let clients = this.sseClients.get(conversationId);
    if (!clients) {
      clients = new Set();
      this.sseClients.set(conversationId, clients);
    }
    clients.add(client);
  }

  /** 注销 SSE 客户端 */
  unsubscribeSSE(conversationId: string, client: SSEClient): void {
    const clients = this.sseClients.get(conversationId);
    if (clients) {
      clients.delete(client);
      if (clients.size === 0) {
        this.sseClients.delete(conversationId);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP 路由
  // ---------------------------------------------------------------------------

  private async handleHttp(req: HttpRequest, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";

    // REST API 优先
    if (url.startsWith("/api/")) {
      // 路由匹配基于 pathname（剥离查询串），以便 SSE 的 ?token= 不影响分发
      const pathname = url.split("?")[0] ?? url;
      // SSE 流式接口需要特殊 Content-Type
      if (pathname.startsWith("/api/conversations/") && pathname.endsWith("/stream")) {
        await this.handleSSEStream(req, res);
        return;
      }
      if (url.startsWith("/api/approvals/stream")) {
        await this.handleApprovalStream(req, res);
        return;
      }
      // 审批响应
      if (url.startsWith("/api/approvals/") && req.method === "POST" && url.endsWith("/respond")) {
        await this.handleApprovalRespond(req, res);
        return;
      }
      // 发送消息
      const sendMatch = url.match(/^\/api\/conversations\/([\w-]+)\/messages$/);
      if (sendMatch && req.method === "POST") {
        await this.handleSendMessage(req, res);
        return;
      }
      // 其他 API
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      try {
        await this.handleApi(url, req, res);
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }

    // /uploads/ 静态文件
    if (url.startsWith("/uploads/")) {
      const relPath = url.replace("/uploads/", "");
      const absPath = join(this.workspaceDir, "sessions", relPath);
      if (existsSync(absPath)) {
        const ext = absPath.split(".").pop()?.toLowerCase() ?? "";
        res.writeHead(200, { "Content-Type": mimeForExt(ext) });
        res.end(readFileSync(absPath));
        return;
      }
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    // SPA fallback：/login/* 路由由前端 React Router 处理
    if (url.startsWith("/login/")) {
      const distRoot = join(this.webRoot, "dist");
      const indexPath = join(distRoot, "index.html");
      if (existsSync(indexPath)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(readFileSync(indexPath));
        return;
      }
    }

    // 静态托管
    const target = resolveStaticFile(this.webRoot, url);
    if (target?.kind === "file" && existsSync(target.absPath)) {
      res.writeHead(200, { "Content-Type": contentType(target.absPath) });
      res.end(readFileSync(target.absPath));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  }

  // ---------------------------------------------------------------------------
  // SSE 处理器
  // ---------------------------------------------------------------------------

  /**
   * GET /api/conversations/:id/stream
   * SSE 流：客户端订阅以接收该会话的实时消息
   */
  private async handleSSEStream(req: HttpRequest, res: ServerResponse): Promise<void> {
    // 提取 conversationId（基于 pathname，忽略 ?token= 等查询串）
    const pathname = (req.url ?? "").split("?")[0] ?? "";
    const match = pathname.match(/^\/api\/conversations\/([\w-]+)\/stream$/);
    if (!match) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid stream url" }));
      return;
    }
    const conversationId = match[1]!;

    // 认证
    if (this.sessionStore) {
      const authUserId = await this.authMiddleware(req);
      if (!authUserId) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    // SSE 头
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const client: SSEClient = {
      write: (event: SSEEvent) => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      },
      close: () => {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      },
    };

    this.subscribeSSE(conversationId, client);

    // 发送连接确认
    client.write({ type: "text", text: "" });

    // 保持连接
    const keepAlive = setInterval(() => {
      try {
        res.write(":\n\n");
      } catch {
        /* ignore */
      }
    }, 30_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      this.unsubscribeSSE(conversationId, client);
    });
  }

  /**
   * GET /api/approvals/stream
   * SSE 流：客户端订阅以接收审批请求推送
   */
  private async handleApprovalStream(req: HttpRequest, res: ServerResponse): Promise<void> {
    if (this.sessionStore) {
      const authUserId = await this.authMiddleware(req);
      if (!authUserId) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const client: SSEClient = {
      write: (event: SSEEvent) => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      },
      close: () => {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      },
    };

    const keepAlive = setInterval(() => {
      try {
        res.write(":\n\n");
      } catch {
        /* ignore */
      }
    }, 30_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      client.close();
    });
  }

  /**
   * POST /api/approvals/:id/respond
   * 审批响应（通过 HTTP POST 替代 WebSocket 双向通信）
   */
  private async handleApprovalRespond(req: HttpRequest, res: ServerResponse): Promise<void> {
    const match = req.url?.match(/^\/api\/approvals\/([\w-]+)\/respond$/);
    if (!match) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid approval url" }));
      return;
    }
    const approvalId = match[1]!;

    const body = JSON.parse(await this.readBody(req)) as {
      approved: boolean;
      reason?: string;
    };

    const resolve = this.pendingApprovalResolves.get(approvalId);
    if (resolve) {
      this.pendingApprovalResolves.delete(approvalId);
      resolve({ approved: body.approved, reason: body.reason });
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "approval not found or expired" }));
    }
  }

  /**
   * POST /api/conversations/:id/messages
   * 发送消息（替代 WebSocket）
   */
  private async handleSendMessage(req: HttpRequest, res: ServerResponse): Promise<void> {
    const match = req.url?.match(/^\/api\/conversations\/([\w-]+)\/messages$/);
    if (!match) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid conversation url" }));
      return;
    }
    const conversationId = match[1]!;

    // 认证
    if (this.sessionStore) {
      const authUserId = await this.authMiddleware(req);
      if (!authUserId) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      (req as HttpRequest & { userId?: string }).userId = authUserId;
    }

    const body = JSON.parse(await this.readBody(req)) as {
      text: string;
      files?: Array<{ path: string; name: string; type: "image" | "markdown" }>;
    };

    // 持久化用户消息
    if (this.messageStore) {
      await this.messageStore
        .add(conversationId, "user", body.text, JSON.stringify(body.files ?? []))
        .catch((e) => console.error("[web] 保存用户消息失败", e));
    }

    // 调用消息处理器
    if (this.handler) {
      this.handler({
        channelId: "web",
        threadId: conversationId, // SSE 模式下用 conversationId 作为 threadId
        requesterId: (req as HttpRequest & { userId?: string }).userId ?? "web-user",
        text: body.text,
        conversationId,
      });
    }

    res.writeHead(202);
    res.end(JSON.stringify({ ok: true, conversationId }));
  }

  // ---------------------------------------------------------------------------
  // 原有 API 路由
  // ---------------------------------------------------------------------------

  private async handleApi(url: string, req: HttpRequest, res: ServerResponse): Promise<void> {
    // 免认证路由
    const publicRoutes = ["/api/auth/qrcode-url", "/api/auth/dingtalk/callback", "/api/health"];
    const isPublic = publicRoutes.some((r) => url.startsWith(r));

    if (!isPublic && this.sessionStore) {
      const authUserId = await this.authMiddleware(req);
      if (!authUserId) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "unauthorized", message: "请先登录" }));
        return;
      }
      (req as HttpRequest & { userId?: string }).userId = authUserId;
    }

    // === Auth 路由 ===

    // GET /api/auth/qrcode-url
    if (url === "/api/auth/qrcode-url" && req.method === "GET") {
      if (!this.dingtalkConfig) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "钉钉登录未配置" }));
        return;
      }
      const state = `${Date.now()}-${Math.random()}`;
      this.oauthStateMap.set(state, Date.now() + 5 * 60 * 1000);
      for (const [s, exp] of this.oauthStateMap) {
        if (Date.now() > exp) this.oauthStateMap.delete(s);
      }
      const redirectUri = `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host ?? "localhost"}/api/auth/dingtalk/callback`;
      const qrUrl = `https://login.dingtalk.com/oauth2/auth?redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&client_id=${encodeURIComponent(this.dingtalkConfig.appKey)}&scope=${encodeURIComponent("openid corpid")}&state=${state}&prompt=consent`;
      res.writeHead(200);
      res.end(JSON.stringify({ url: qrUrl }));
      return;
    }

    // GET /api/auth/dingtalk/callback
    if (url.startsWith("/api/auth/dingtalk/callback") && req.method === "GET") {
      const code = this.extractQuery(url, "code");
      const state = this.extractQuery(url, "state");
      if (!code) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "缺少 code 参数" }));
        return;
      }
      if (state) {
        const exp = this.oauthStateMap.get(state);
        if (!exp || Date.now() > exp) {
          console.warn("[auth] OAuth state 校验失败或过期:", state);
        }
        this.oauthStateMap.delete(state ?? "");
      }

      if (!this.dingtalkConfig || !this.deps.userStore || !this.sessionStore) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "认证服务未就绪" }));
        return;
      }

      try {
        const { getUserAccessToken, getUserInfoByOAuth } = await import("../util/dingtalk-api.js");
        const tokenResult = await getUserAccessToken(
          this.dingtalkConfig.appKey,
          this.dingtalkConfig.appSecret,
          code,
        );
        const userInfo = await getUserInfoByOAuth(tokenResult.accessToken);
        // 统一身份模型：直接按 identity 查找/创建并绑定，不再走合并流程。
        const user = await this.deps.userStore.getOrCreateByIdentity(
          "dingtalk",
          userInfo.userId,
          userInfo.name,
          userInfo.avatar,
        );
        const { token } = await this.sessionStore.create(user.id);
        res.writeHead(302, { Location: `/login/success?token=${token}` });
        res.end();
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error("[auth] 钉钉回调处理失败:", errMsg);
        res.writeHead(302, { Location: `/login?error=${encodeURIComponent(errMsg)}` });
        res.end();
      }
      return;
    }

    // GET /api/auth/me
    if (url === "/api/auth/me" && req.method === "GET") {
      const uid = (req as HttpRequest & { userId?: string }).userId;
      if (!uid || !this.deps.userStore) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const user = await this.deps.userStore.get(uid);
      if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "user not found" }));
        return;
      }
      const identities = await this.deps.userStore.getIdentities(uid);
      res.writeHead(200);
      res.end(
        JSON.stringify({
          user: {
            id: user.id,
            name: user.name,
            avatar: user.avatar,
            role: user.role,
            createdAt: user.createdAt,
          },
          identities,
        }),
      );
      return;
    }

    // POST /api/auth/merge-confirm —— 已废弃：统一身份模型下不再需要合并流程
    if (url === "/api/auth/merge-confirm" && req.method === "POST") {
      res.writeHead(410);
      res.end(JSON.stringify({ error: "合并流程已废弃，请重新登录" }));
      return;
    }

    // POST /api/auth/logout
    if (url === "/api/auth/logout" && req.method === "POST") {
      const uid = (req as HttpRequest & { userId?: string }).userId;
      if (!uid || !this.sessionStore) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const auth = req.headers["authorization"];
      if (auth?.startsWith("Bearer ")) {
        const token = auth.slice(7);
        const payload = this.decodeJwtPayload(token);
        if (payload?.jti) {
          await this.sessionStore.revoke(payload.jti as string);
        }
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /api/tasks
    if (url === "/api/tasks" && req.method === "GET") {
      const status = this.extractQuery(url, "status");
      const tasks = status
        ? ((await this.deps.taskStore?.listByStatus(status as never)) ?? [])
        : ((await this.deps.taskStore
            ?.listByStatus("done" as never)
            .then(async (d) => [
              ...d,
              ...((await this.deps.taskStore?.listByStatus("failed" as never)) ?? []),
              ...((await this.deps.taskStore?.listByStatus("running" as never)) ?? []),
              ...((await this.deps.taskStore?.listByStatus("created" as never)) ?? []),
            ])) ?? []);
      res.writeHead(200);
      res.end(JSON.stringify(tasks));
      return;
    }

    // GET /api/tasks/:id
    const taskMatch = url.match(/^\/api\/tasks\/([\w-]+)$/);
    if (taskMatch && req.method === "GET") {
      const task = await this.deps.taskStore?.get(taskMatch[1] ?? "");
      res.writeHead(task ? 200 : 404);
      res.end(JSON.stringify(task ?? { error: "not found" }));
      return;
    }

    // GET /api/users
    if (url === "/api/users" && req.method === "GET") {
      const users = (await this.deps.userStore?.list()) ?? [];
      res.writeHead(200);
      res.end(JSON.stringify(users));
      return;
    }

    // GET /api/users/:id/memory
    const memMatch = url.match(/^\/api\/users\/([\w-]+)\/memory$/);
    if (memMatch && req.method === "GET") {
      const user = await this.deps.userStore?.get(memMatch[1] ?? "");
      if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "user not found" }));
        return;
      }
      const mem = new MemoryStore(join(user.homeDir, "memory"));
      res.writeHead(200);
      res.end(JSON.stringify(mem.list()));
      return;
    }

    // GET /api/conversations/:id/messages — 会话消息列表
    const msgMatch = url.match(/^\/api\/conversations\/([\w-]+)\/messages$/);
    if (msgMatch && req.method === "GET") {
      const conversationId = msgMatch[1] ?? "";
      if (!this.messageStore) {
        res.writeHead(200);
        res.end(JSON.stringify([]));
        return;
      }
      const stored = await this.messageStore.listByConversation(conversationId);
      const messages = stored.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        files: JSON.parse(m.files) as Array<{
          path: string;
          name: string;
          type: "image" | "markdown";
        }>,
      }));
      res.writeHead(200);
      res.end(JSON.stringify(messages));
      return;
    }

    // GET /api/conversations?userId=xxx（userId 为 users.id）
    if (url.startsWith("/api/conversations") && req.method === "GET") {
      const userId = this.extractQuery(url, "userId");
      if (userId && this.deps.userStore) {
        const user = await this.deps.userStore.get(userId);
        if (!user) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "user not found" }));
          return;
        }
      }
      if (userId) {
        const list = (await this.deps.conversationStore?.listByUser(userId)) ?? [];
        res.writeHead(200);
        res.end(JSON.stringify(list));
      } else {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "userId required" }));
      }
      return;
    }
    if (url === "/api/conversations" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify([]));
      return;
    }

    // POST /api/upload
    if (url.startsWith("/api/upload") && req.method === "POST") {
      await this.handleUpload(req, res);
      return;
    }

    // POST /api/conversations（userId 为 users.id）
    if (url === "/api/conversations" && req.method === "POST") {
      const body = await this.readBody(req);
      const { userId, channelId } = JSON.parse(body) as { userId: string; channelId?: string };
      if (userId && this.deps.userStore) {
        const user = await this.deps.userStore.get(userId);
        if (!user) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "user not found" }));
          return;
        }
      }
      const conv = await this.deps.conversationStore?.create(userId, channelId ?? "web", "新对话");
      res.writeHead(201);
      res.end(JSON.stringify(conv));
      return;
    }

    // DELETE /api/conversations/:id
    const delConvMatch = url.match(/^\/api\/conversations\/([\w-]+)$/);
    if (delConvMatch && req.method === "DELETE") {
      await this.deps.conversationStore?.update(delConvMatch[1] ?? "", { archived: true });
      res.writeHead(204);
      res.end();
      return;
    }

    // GET /api/audit/conversations
    if (url === "/api/audit/conversations" && req.method === "GET") {
      const summaries = (await this.deps.auditStore?.listConversationSummaries()) ?? [];
      const out = await Promise.all(
        summaries.map(async (s) => {
          const conv = await this.deps.conversationStore?.get(s.conversationId);
          return {
            ...s,
            title: conv?.title ?? "",
            userId: conv?.userId ?? "",
            channelId: conv?.channelId ?? "",
            createdAt: conv?.createdAt ?? "",
          };
        }),
      );
      res.writeHead(200);
      res.end(JSON.stringify(out));
      return;
    }

    // GET /api/audit/conversations/:id
    const auditDetailMatch = url.match(/^\/api\/audit\/conversations\/([\w-]+)$/);
    if (auditDetailMatch && req.method === "GET") {
      const conversationId = auditDetailMatch[1] ?? "";
      const events = (await this.deps.auditStore?.listByConversation(conversationId)) ?? [];
      if (events.length === 0) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "no audit data" }));
        return;
      }
      const conversation = await this.deps.conversationStore?.get(conversationId);
      const byTask = new Map<string, typeof events>();
      for (const e of events) {
        const arr = byTask.get(e.taskId) ?? [];
        arr.push(e);
        byTask.set(e.taskId, arr);
      }
      const turns = await Promise.all(
        [...byTask.entries()].map(async ([taskId, evs]) => {
          const task = await this.deps.taskStore?.get(taskId);
          const result = evs.find((e) => e.type === "result");
          return {
            taskId,
            prompt: task?.prompt ?? "",
            status: task?.status ?? "",
            createdAt: task?.createdAt ?? "",
            durationMs: result?.durationMs,
            usage: result?.usage,
            events: evs,
          };
        }),
      );
      res.writeHead(200);
      res.end(JSON.stringify({ conversation, turns }));
      return;
    }

    // GET /api/usage
    if ((url === "/api/usage" || url.startsWith("/api/usage?")) && req.method === "GET") {
      const userId = this.extractQuery(url, "userId");
      const taskId = this.extractQuery(url, "taskId");
      const since = this.extractQuery(url, "since");
      const until = this.extractQuery(url, "until");
      const limitStr = this.extractQuery(url, "limit");
      let limit: number | undefined;
      if (limitStr !== undefined) {
        const n = Number(limitStr);
        if (!Number.isInteger(n) || n <= 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "limit must be a positive integer" }));
          return;
        }
        limit = n;
      }
      const records =
        (await this.deps.usageStore?.list({ userId, taskId, since, until, limit })) ?? [];
      res.writeHead(200);
      res.end(JSON.stringify({ records }));
      return;
    }

    // GET /api/health
    if (url === "/api/health") {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, channel: "web" }));
      return;
    }

    // GET /api/files/tree
    if (url.startsWith("/api/files/tree") && req.method === "GET") {
      await this.handleFileTree(req, res);
      return;
    }
    // GET /api/files/content
    if (url.startsWith("/api/files/content") && req.method === "GET") {
      await this.handleFileContent(req, res);
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "unknown endpoint" }));
  }

  /** GET /api/files/tree?scope=user|runtime[&conversationId=] */
  private async handleFileTree(req: HttpRequest, res: ServerResponse): Promise<void> {
    if (!this.fileBrowser) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "文件浏览未启用" }));
      return;
    }
    const userId = (req as HttpRequest & { userId?: string }).userId ?? "";
    const scope = this.extractQuery(req.url ?? "", "scope");
    const conversationId = this.extractQuery(req.url ?? "", "conversationId");
    if (scope !== "user" && scope !== "runtime") {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "scope 必须是 user 或 runtime" }));
      return;
    }
    if (scope === "runtime" && !conversationId) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "runtime 需要 conversationId" }));
      return;
    }
    try {
      const nodes = await this.fileBrowser.listTree(userId, scope, conversationId);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ nodes }));
    } catch (e) {
      this.writeFileInfoError(res, e);
    }
  }

  /** GET /api/files/content?scope=&path=&[conversationId=][&download=1] */
  private async handleFileContent(req: HttpRequest, res: ServerResponse): Promise<void> {
    if (!this.fileBrowser) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "文件浏览未启用" }));
      return;
    }
    const userId = (req as HttpRequest & { userId?: string }).userId ?? "";
    const scope = this.extractQuery(req.url ?? "", "scope");
    const rawPath = this.extractQuery(req.url ?? "", "path");
    const conversationId = this.extractQuery(req.url ?? "", "conversationId");
    const download = this.extractQuery(req.url ?? "", "download") === "1";
    if (scope !== "user" && scope !== "runtime") {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "scope 必须是 user 或 runtime" }));
      return;
    }
    if (!rawPath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "缺少 path" }));
      return;
    }
    try {
      const content = await this.fileBrowser.readFile(userId, scope, rawPath, conversationId, {
        maxBytes: download ? 50 * 1024 * 1024 : 5 * 1024 * 1024,
      });
      const headers: Record<string, string> = {
        "Content-Type": content.mime,
        "X-Content-Type-Options": "nosniff",
      };
      if (download) {
        const name = rawPath.split("/").pop() ?? "file";
        headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
      }
      res.writeHead(200, headers);
      res.end(content.buffer);
    } catch (e) {
      this.writeFileInfoError(res, e);
    }
  }

  private writeFileInfoError(res: ServerResponse, e: unknown): void {
    if (e instanceof ForbiddenError) {
      res.writeHead(403);
    } else if (e instanceof NotFoundError) {
      res.writeHead(404);
    } else if (e instanceof PayloadTooLargeError) {
      res.writeHead(413);
    } else {
      res.writeHead(500);
    }
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }

  /** Auth 中间件：优先 Authorization 头；SSE 的 EventSource 无法设置自定义头，回退读 ?token= */
  private async authMiddleware(req: HttpRequest): Promise<string | null> {
    if (!this.sessionStore) return null;
    const auth = req.headers["authorization"];
    const token = auth?.startsWith("Bearer ")
      ? auth.slice(7)
      : this.extractQuery(req.url ?? "", "token");
    if (!token) return null;
    return this.sessionStore.verify(token);
  }

  private decodeJwtPayload(token: string): Record<string, unknown> | null {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      return JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    } catch {
      return null;
    }
  }

  private async handleUpload(req: HttpRequest, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const threadId = url.searchParams.get("threadId");
    if (!threadId) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "缺少 threadId 参数" }));
      return;
    }

    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.startsWith("multipart/form-data")) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "请求格式错误" }));
      return;
    }

    return new Promise<void>((resolve) => {
      let fileSaved = false;

      const bb = Busboy({
        headers: req.headers as Record<string, string>,
        limits: { fileSize: 2 * 1024 * 1024, files: 1 },
      });

      bb.on(
        "file",
        (
          _fieldname: string,
          file: NodeJS.ReadableStream,
          info: { filename: string; encoding: string; mimeType: string },
        ) => {
          const { filename, mimeType } = info;
          const ext = filename.split(".").pop()?.toLowerCase();
          const isImage =
            mimeType?.startsWith("image/") &&
            ["jpg", "jpeg", "png", "gif", "webp"].includes(ext ?? "");
          const isMarkdown = ext === "md" || mimeType === "text/markdown";

          if (!isImage && !isMarkdown) {
            file.resume();
            res.writeHead(400);
            res.end(
              JSON.stringify({
                error: "不支持的文件类型，仅支持图片(.jpg/.png/.gif/.webp)和Markdown(.md)",
              }),
            );
            resolve();
            return;
          }

          const chunks: Buffer[] = [];
          let totalSize = 0;

          file.on("data", (chunk: Buffer) => {
            totalSize += chunk.length;
            if (totalSize > 2 * 1024 * 1024) {
              file.resume();
              res.writeHead(400);
              res.end(JSON.stringify({ error: "文件大小超过 2MB 限制" }));
              resolve();
              return;
            }
            chunks.push(chunk);
          });

          file.on("limit", () => {
            file.resume();
            res.writeHead(400);
            res.end(JSON.stringify({ error: "文件大小超过 2MB 限制" }));
            resolve();
          });

          file.on("end", () => {
            if (fileSaved) return;
            fileSaved = true;

            const ts = Date.now();
            const saveName = `${ts}-${filename}`;
            const sessionDir = join(this.workspaceDir, "sessions", threadId);
            mkdirSync(sessionDir, { recursive: true });
            const absPath = join(sessionDir, saveName);
            writeFileSync(absPath, Buffer.concat(chunks));

            const type = isImage ? "image" : "markdown";

            res.writeHead(200);
            res.end(
              JSON.stringify({
                path: absPath,
                name: filename,
                type,
                url: `/uploads/${threadId}/${saveName}`,
              }),
            );
            resolve();
          });
        },
      );

      bb.on("error", () => {
        if (!fileSaved) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "文件保存失败" }));
        }
        resolve();
      });

      req.pipe(bb);
    });
  }

  private extractQuery(url: string, key: string): string | undefined {
    const u = new URL(url, "http://localhost");
    return u.searchParams.get(key) ?? undefined;
  }

  private readBody(req: HttpRequest): Promise<string> {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk;
      });
      req.on("end", () => resolve(body));
    });
  }

  /** 等 HTTP 服务监听就绪 */
  async ready(): Promise<void> {
    await this.readyPromise;
  }

  get boundPort(): number | undefined {
    const addr = this.server?.address();
    return typeof addr === "object" && addr ? addr.port : undefined;
  }

  stop(): void {
    this.server?.close();
  }
}
