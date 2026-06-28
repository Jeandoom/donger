import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type WebSocket, WebSocketServer } from "ws";
import type { ApprovalCard, IncomingMessage, OutgoingMessage } from "../domain/types.js";
import type { Channel } from "../ports/channel.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** WebSocket 消息（浏览器 ↔ 服务端） */
type WsIn =
  | { type: "message"; text: string; userId?: string }
  | { type: "approval"; approved: boolean; reason?: string };

type WsOut =
  | { type: "text"; text: string }
  | { type: "approval_card"; gateId: string; title: string; summary: string }
  | { type: "result"; subtype: "success" | "error"; text: string };

/**
 * Web Channel：浏览器对话客户端。
 * HTTP 静态文件 + WebSocket 双向通信。
 * 每个 WebSocket 连接 = 一个 thread；消息→handler，回复→ws.send。
 * 审批：推 approval_card → 等浏览器回 approval。
 */
export class WebChannel implements Channel {
  readonly id = "web";
  private handler?: (msg: IncomingMessage) => void;
  private server?: Server;
  private wss?: WebSocketServer;
  /** threadId(=连接id) → WebSocket */
  private readonly sockets = new Map<string, WebSocket>();
  /** threadId → pending 审批 resolve */
  private readonly pendingApprovals = new Map<
    string,
    (d: { approved: boolean; reason?: string }) => void
  >();
  private nextId = 0;

  constructor(private readonly port: number = 3000) {}

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;

    const server = createServer((req, res) => {
      if (req.url === "/" || req.url === "/index.html") {
        const htmlPath = join(__dirname, "..", "..", "web", "index.html");
        if (existsSync(htmlPath)) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(readFileSync(htmlPath, "utf8"));
          return;
        }
      }
      res.writeHead(404);
      res.end("Not found");
    });

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
    server.listen(this.port);
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

    const out: WsOut = {
      type: "approval_card",
      gateId: card.gateId,
      title: card.title,
      summary: card.summary,
    };
    ws.send(JSON.stringify(out));

    return new Promise((resolve) => {
      this.pendingApprovals.set(threadId, resolve);
    });
  }

  stop(): void {
    this.wss?.close();
    this.server?.close();
  }
}
