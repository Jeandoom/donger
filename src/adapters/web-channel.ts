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
import { type WebSocket, WebSocketServer } from "ws";
import type { ApprovalCard, IncomingMessage, OutgoingMessage } from "../domain/types.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { AuditStore } from "../ports/audit-store.js";
import type { Channel } from "../ports/channel.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import type { SessionStore } from "../ports/session-store.js";
import type { TaskStore } from "../ports/task-store.js";
import type { UsageStore } from "../ports/usage-store.js";
import type { UserStore } from "../ports/user-store.js";

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

type WsIn =
  | {
      type: "message";
      text: string;
      conversationId?: string;
      files?: Array<{
        path: string;
        name: string;
        type: "image" | "markdown";
      }>;
    }
  | { type: "approval"; approved: boolean; reason?: string };

type WsOut =
  | { type: "text"; text: string }
  | { type: "approval_card"; gateId: string; title: string; summary: string }
  | { type: "result"; subtype: "success" | "error"; text: string };

export interface WebChannelDeps {
  port: number;
  /** 上传文件保存根目录 */
  workspaceDir: string;
  taskStore?: TaskStore;
  userStore?: UserStore;
  conversationStore?: ConversationStore;
  usageStore?: UsageStore;
  auditStore?: AuditStore;
  sessionStore?: SessionStore;
  dingtalkConfig?: { appKey: string; appSecret: string };
  /** web 前端根目录（默认 <repo>/web）；测试可指向临时目录 */
  webRoot?: string;
}

export class WebChannel implements Channel {
  readonly id = "web";
  readonly streaming = true;
  private handler?: (msg: IncomingMessage) => void;
  private server?: Server;
  private wss?: WebSocketServer;
  private readyPromise?: Promise<void>;
  private readonly sockets = new Map<string, WebSocket>();
  private readonly pendingApprovals = new Map<
    string,
    (d: { approved: boolean; reason?: string }) => void
  >();
  private nextId = 0;
  private readonly webRoot: string;
  private readonly workspaceDir: string;
  private readonly sessionStore?: SessionStore;
  private readonly dingtalkConfig?: { appKey: string; appSecret: string };
  private readonly oauthStateMap = new Map<string, number>();

  constructor(private readonly deps: WebChannelDeps) {
    this.webRoot = deps.webRoot ?? join(__dirname, "..", "..", "web");
    this.workspaceDir = deps.workspaceDir;
    this.sessionStore = deps.sessionStore;
    this.dingtalkConfig = deps.dingtalkConfig;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;

    const server = createServer((req, res) => this.handleHttp(req, res));

    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", async (ws, req) => {
      // 校验 WebSocket token
      let userId = "web-user";
      if (this.sessionStore) {
        const url = new URL(req.url ?? "", "http://localhost");
        const token = url.searchParams.get("token");
        if (!token) {
          ws.close(4001, "missing_token");
          return;
        }
        const verified = await this.sessionStore.verify(token);
        if (!verified) {
          ws.close(4001, "invalid_token");
          return;
        }
        userId = verified;
      }

      const threadId = `web-${++this.nextId}`;
      this.sockets.set(threadId, ws);
      (ws as WebSocket & { userId: string }).userId = userId;

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as WsIn;
          if (msg.type === "message") {
            let finalText = msg.text;

            if (msg.files && msg.files.length > 0) {
              for (const file of msg.files) {
                if (file.type === "markdown") {
                  try {
                    const content = readFileSync(file.path, "utf-8");
                    finalText += `\n\n--- 用户上传的文件：${file.name} ---\n${content}`;
                  } catch {
                    finalText += `\n\n[无法读取文件：${file.name}]`;
                  }
                } else if (file.type === "image") {
                  finalText += `\n\n![${file.name}](file://${file.path})`;
                }
              }
            }

            this.handler?.({
              channelId: "web",
              threadId,
              requesterId: (ws as WebSocket & { userId: string }).userId,
              text: finalText,
              conversationId: msg.conversationId,
            });
          } else if (msg.type === "approval") {
            const resolve = this.pendingApprovals.get(threadId);
            if (resolve) {
              this.pendingApprovals.delete(threadId);
              resolve({ approved: msg.approved, reason: msg.reason });
            }
          }
        } catch (e) {
          console.error("[web] 消息解析失败", e);
        }
      });

      ws.on("close", () => {
        this.sockets.delete(threadId);
        this.pendingApprovals.delete(threadId);
      });
    });

    this.server = server;
    this.wss = wss;
    this.readyPromise = new Promise<void>((resolve) => {
      server.listen(this.deps.port, () => resolve());
    });
  }

  /** HTTP 路由：静态文件 + REST API */
  private async handleHttp(req: HttpRequest, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";

    // REST API 优先（避免被 SPA fallback 吞掉）
    if (url.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      try {
        await this.handleApi(url, req, res);
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }

    // /uploads/ 静态文件（上传文件预览）
    if (url.startsWith("/uploads/")) {
      const relPath = url.replace("/uploads/", "");
      const absPath = join(this.workspaceDir, "sessions", relPath);
      if (existsSync(absPath)) {
        const ext = absPath.split(".").pop()?.toLowerCase();
        const mimeMap: Record<string, string> = {
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          png: "image/png",
          gif: "image/gif",
          webp: "image/webp",
          md: "text/markdown; charset=utf-8",
        };
        res.writeHead(200, { "Content-Type": mimeMap[ext ?? ""] ?? "application/octet-stream" });
        res.end(readFileSync(absPath));
        return;
      }
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    // 静态托管：优先 web/dist（SPA fallback）
    const target = resolveStaticFile(this.webRoot, url);
    if (target?.kind === "file" && existsSync(target.absPath)) {
      res.writeHead(200, { "Content-Type": contentType(target.absPath) });
      res.end(readFileSync(target.absPath));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  }

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

    // GET /api/auth/qrcode-url — 获取钉钉扫码 URL
    if (url === "/api/auth/qrcode-url" && req.method === "GET") {
      if (!this.dingtalkConfig) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "钉钉登录未配置" }));
        return;
      }
      const state = crypto.randomUUID();
      this.oauthStateMap.set(state, Date.now() + 5 * 60 * 1000); // 5 分钟过期
      // 清理过期 state
      for (const [s, exp] of this.oauthStateMap) {
        if (Date.now() > exp) this.oauthStateMap.delete(s);
      }
      const redirectUri = `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host ?? "localhost"}/api/auth/dingtalk/callback`;
      const qrUrl = `https://oapi.dingtalk.com/connect/qrconnect?app_id=${encodeURIComponent(this.dingtalkConfig.appKey)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
      res.writeHead(200);
      res.end(JSON.stringify({ url: qrUrl }));
      return;
    }

    // GET /api/auth/dingtalk/callback — 钉钉 OAuth 回调
    if (url.startsWith("/api/auth/dingtalk/callback") && req.method === "GET") {
      const code = this.extractQuery(url, "code");
      const state = this.extractQuery(url, "state");
      if (!code) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "缺少 code 参数" }));
        return;
      }
      // 校验 state（防 CSRF）
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
        const oauthToken = await getUserAccessToken(
          this.dingtalkConfig.appKey, this.dingtalkConfig.appSecret, code,
        );
        const userInfo = await getUserInfoByOAuth(oauthToken.accessToken);

        // 查 identity
        const existing = await this.deps.userStore.findByIdentity("dingtalk", userInfo.userId);

        if (existing) {
          // 已有用户：签发 JWT → redirect 到合并确认页
          const { token } = await this.sessionStore.create(existing.id);
          res.writeHead(302, {
            Location: `/login/merge?token=${token}&userId=${existing.id}&name=${encodeURIComponent(existing.name)}&avatar=${encodeURIComponent(userInfo.avatar ?? "")}`,
          });
          res.end();
        } else {
          // 新用户：创建 User + identity → 签发 JWT → redirect 到成功页
          const user = await this.deps.userStore.getOrCreate(userInfo.userId, userInfo.name);
          await this.deps.userStore.addIdentity(user.id, {
            id: crypto.randomUUID(),
            userId: user.id,
            provider: "dingtalk",
            externalId: userInfo.userId,
            name: userInfo.name,
            avatar: userInfo.avatar,
            createdAt: new Date().toISOString(),
          });
          if (userInfo.avatar) {
            await this.deps.userStore.updateProfile(user.id, { avatar: userInfo.avatar });
          }
          const { token } = await this.sessionStore.create(user.id);
          res.writeHead(302, {
            Location: `/login/success?token=${token}`,
          });
          res.end();
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error("[auth] 钉钉回调处理失败:", errMsg);
        res.writeHead(302, { Location: `/login?error=${encodeURIComponent(errMsg)}` });
        res.end();
      }
      return;
    }

    // GET /api/auth/me — 当前用户信息
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
      res.end(JSON.stringify({ user: { id: user.id, name: user.name, avatar: user.avatar, role: user.role, createdAt: user.createdAt }, identities }));
      return;
    }

    // POST /api/auth/merge-confirm — 确认合并
    if (url === "/api/auth/merge-confirm" && req.method === "POST") {
      const uid = (req as HttpRequest & { userId?: string }).userId;
      if (!uid || !this.deps.userStore || !this.sessionStore) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body = JSON.parse(await this.readBody(req)) as { sourceUserId?: string };
      if (!body.sourceUserId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "缺少 sourceUserId" }));
        return;
      }
      try {
        await this.deps.userStore.mergeUsers(body.sourceUserId, uid);
        const user = await this.deps.userStore.get(uid);
        const { token } = await this.sessionStore.create(uid);
        res.writeHead(200);
        res.end(JSON.stringify({
          token,
          user: { id: user?.id, name: user?.name, avatar: user?.avatar, role: user?.role },
        }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }

    // POST /api/auth/logout — 主动登出
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

    // GET /api/tasks — 任务列表
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

    // GET /api/tasks/:id — 任务详情
    const taskMatch = url.match(/^\/api\/tasks\/([\w-]+)$/);
    if (taskMatch && req.method === "GET") {
      const task = await this.deps.taskStore?.get(taskMatch[1] ?? "");
      res.writeHead(task ? 200 : 404);
      res.end(JSON.stringify(task ?? { error: "not found" }));
      return;
    }

    // GET /api/users — 用户列表
    if (url === "/api/users" && req.method === "GET") {
      const users = (await this.deps.userStore?.list()) ?? [];
      res.writeHead(200);
      res.end(JSON.stringify(users));
      return;
    }

    // GET /api/users/:id/memory — 用户记忆
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

    // GET /api/conversations?userId=xxx — 会话列表
    if (url.startsWith("/api/conversations") && req.method === "GET") {
      let userId = this.extractQuery(url, "userId");
      // 解析 staffId → 内部 user.id
      if (userId && this.deps.userStore) {
        const user = await this.deps.userStore.getByStaffId(userId);
        if (user) userId = user.id;
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

    // POST /api/upload — 文件上传
    if (url.startsWith("/api/upload") && req.method === "POST") {
      await this.handleUpload(req, res);
      return;
    }

    // POST /api/conversations — 创建新会话
    if (url === "/api/conversations" && req.method === "POST") {
      const body = await this.readBody(req);
      const { userId, channelId } = JSON.parse(body) as { userId: string; channelId?: string };
      // 解析 staffId → 内部 user.id（conversation 统一用内部 user.id 关联）
      let resolvedUserId = userId;
      if (userId && this.deps.userStore) {
        const user = await this.deps.userStore.getByStaffId(userId);
        if (user) resolvedUserId = user.id;
      }
      const conv = await this.deps.conversationStore?.create(
        resolvedUserId,
        channelId ?? "web",
        "新对话",
      );
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

    // GET /api/audit/conversations — 审计会话列表（summary + 会话元信息）
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

    // GET /api/audit/conversations/:id — 会话详情（按轮分组）
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
      // 按 taskId 分组（组内已按 recordedAt,seq 升序）
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

    // GET /api/usage — 用量记录列表（可按 userId/taskId/since/until/limit 过滤）
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

    res.writeHead(404);
    res.end(JSON.stringify({ error: "unknown endpoint" }));
  }

  /** Auth 中间件：校验 JWT Bearer Token，返回 userId 或 null */
  private async authMiddleware(req: HttpRequest): Promise<string | null> {
    if (!this.sessionStore) return null;
    const auth = req.headers["authorization"];
    if (!auth || !auth.startsWith("Bearer ")) return null;
    const token = auth.slice(7);
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

  async send(threadId: string, msg: OutgoingMessage): Promise<void> {
    const ws = this.sockets.get(threadId);
    if (!ws) return;
    const out: WsOut = { type: "text", text: msg.text };
    ws.send(JSON.stringify(out));
  }

  async requestApproval(
    threadId: string,
    card: ApprovalCard,
  ): Promise<{ approved: boolean; reason?: string }> {
    const ws = this.sockets.get(threadId);
    if (!ws) throw new Error("WebSocket 连接已断开");

    ws.send(
      JSON.stringify({
        type: "approval_card",
        gateId: card.gateId,
        title: card.title,
        summary: card.summary,
      }),
    );

    return new Promise((resolve) => {
      this.pendingApprovals.set(threadId, resolve);
    });
  }

  /** 等 HTTP 服务监听就绪（测试用：port=0 时 await 后再读 boundPort）。 */
  async ready(): Promise<void> {
    await this.readyPromise;
  }

  get boundPort(): number | undefined {
    const addr = this.server?.address();
    return typeof addr === "object" && addr ? addr.port : undefined;
  }

  stop(): void {
    this.wss?.close();
    this.server?.close();
  }
}