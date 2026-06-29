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
import type { TaskStore } from "../ports/task-store.js";
import type { UserStore } from "../ports/user-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

type WsIn =
  | { type: "message"; text: string; userId?: string }
  | { type: "approval"; approved: boolean; reason?: string };

type WsOut =
  | { type: "text"; text: string }
  | { type: "approval_card"; gateId: string; title: string; summary: string }
  | { type: "result"; subtype: "success" | "error"; text: string };

export interface WebChannelDeps {
  port: number;
  taskStore?: TaskStore;
  userStore?: UserStore;
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

  constructor(private readonly deps: WebChannelDeps) {}

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

    // 静态文件
    if (url === "/" || url === "/index.html") {
      const htmlPath = join(__dirname, "..", "..", "web", "index.html");
      if (existsSync(htmlPath)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(readFileSync(htmlPath, "utf8"));
        return;
      }
    }

    // REST API
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
