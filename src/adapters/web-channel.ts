import { existsSync, readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage as HttpRequest,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type WebSocket, WebSocketServer } from "ws";
import type { ApprovalCard, IncomingMessage, OutgoingMessage } from "../domain/types.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { Channel } from "../ports/channel.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import type { TaskStore } from "../ports/task-store.js";
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
  | { type: "message"; text: string; userId?: string; conversationId?: string }
  | { type: "approval"; approved: boolean; reason?: string };

type WsOut =
  | { type: "text"; text: string }
  | { type: "approval_card"; gateId: string; title: string; summary: string }
  | { type: "result"; subtype: "success" | "error"; text: string };

export interface WebChannelDeps {
  port: number;
  taskStore?: TaskStore;
  userStore?: UserStore;
  conversationStore?: ConversationStore;
  /** web 前端根目录（默认 <repo>/web）；测试可指向临时目录 */
  webRoot?: string;
}

export class WebChannel implements Channel {
  readonly id = "web";
  readonly streaming = true;
  private handler?: (msg: IncomingMessage) => void;
  private server?: Server;
  private wss?: WebSocketServer;
  private readonly sockets = new Map<string, WebSocket>();
  private readonly pendingApprovals = new Map<
    string,
    (d: { approved: boolean; reason?: string }) => void
  >();
  private nextId = 0;
  private readonly webRoot: string;

  constructor(private readonly deps: WebChannelDeps) {
    this.webRoot = deps.webRoot ?? join(__dirname, "..", "..", "web");
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;

    const server = createServer((req, res) => this.handleHttp(req, res));

    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (ws) => {
      const threadId = `web-${++this.nextId}`;
      this.sockets.set(threadId, ws);

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as WsIn;
          if (msg.type === "message") {
            this.handler?.({
              channelId: "web",
              threadId,
              requesterId: msg.userId ?? "web-user",
              text: msg.text,
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
    server.listen(this.deps.port);
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
    if (
      url.startsWith("/api/conversations") &&
      !url.includes("/") === false &&
      req.method === "GET"
    ) {
      const userId = this.extractQuery(url, "userId");
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
      const userId = this.extractQuery(url, "userId");
      const list = (await this.deps.conversationStore?.listByUser(userId ?? "")) ?? [];
      res.writeHead(200);
      res.end(JSON.stringify(list));
      return;
    }

    // POST /api/conversations — 创建新会话
    if (url === "/api/conversations" && req.method === "POST") {
      const body = await this.readBody(req);
      const { userId, channelId } = JSON.parse(body) as { userId: string; channelId?: string };
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

    // GET /api/health
    if (url === "/api/health") {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, channel: "web" }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "unknown endpoint" }));
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

  stop(): void {
    this.wss?.close();
    this.server?.close();
  }
}
