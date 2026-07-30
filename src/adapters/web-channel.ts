import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage as HttpRequest,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Busboy from "busboy";
import { ZodError } from "zod";
import type { LlmPreset } from "../config.js";
import { type Agent, parseAgentInput } from "../domain/agent.js";
import { canManageAgent, canUseAgent } from "../domain/agent-policy.js";
import { mimeForExt } from "../domain/file-mime.js";
import type { GitProvider } from "../domain/git.js";
import type { LLMConfig } from "../domain/llm-config.js";
import { type Loop, parseLoopInput } from "../domain/loop.js";
import type { UserModelConfig } from "../domain/model-config.js";
import { parseUserModelConfig } from "../domain/model-config.js";
import { parseTriggerInput, type Trigger } from "../domain/trigger.js";
import {
  type ApprovalCard,
  type IncomingMessage,
  type MessageFile,
  MessageFileSchema,
  type OutgoingMessage,
} from "../domain/types.js";
import type { User } from "../domain/user.js";
import { parseWorkflowInput, type Workflow } from "../domain/workflow.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { GitAccessCheck, GitAccessGate } from "../orchestrator/git-access-gate.js";
import type { HookRegistry } from "../orchestrator/hook-registry.js";
import type { LoopRunner } from "../orchestrator/loop-runner.js";
import type { SchedulerService } from "../orchestrator/scheduler.js";
import type { AgentShareStore } from "../ports/agent-share-store.js";
import type { AgentStore } from "../ports/agent-store.js";
import type { AuditStore } from "../ports/audit-store.js";
import type { Channel, CredentialRequest, CredentialRequestItem } from "../ports/channel.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import type { CredentialStore } from "../ports/credential-store.js";
import type { FileBrowser } from "../ports/file-browser.js";
import type { GitAuthProviderAdapter } from "../ports/git-auth-provider.js";
import type { GitConnectionStore } from "../ports/git-connection-store.js";
import type { LlmDebugRunner } from "../ports/llm-debug-runner.js";
import type { LoopStore } from "../ports/loop-store.js";
import type { MessageStore } from "../ports/message-store.js";
import type { UserModelConfigStore } from "../ports/model-config-store.js";
import type { SessionStore } from "../ports/session-store.js";
import type { SkillInstaller } from "../ports/skill-installer.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";
import type { TaskStore } from "../ports/task-store.js";
import type { TriggerStore } from "../ports/trigger-store.js";
import type { UsageStore } from "../ports/usage-store.js";
import type { UserStore } from "../ports/user-store.js";
import type { WorkflowStore } from "../ports/workflow-store.js";
import {
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from "../util/errors.js";
import { BUILTIN_TOOLS, discoverSkills } from "../util/skill-discovery.js";
import {
  handleDeleteCredential,
  handleInstall,
  handleInstallUpload,
  handleListCredentials,
  handleListPacks,
  handleSetCredential,
  handleSetPackEnabled,
  handleSetSkillEnabled,
  handleUninstall,
  handleUpdate,
  type SkillApiDeps,
} from "./skill-api.js";

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
  | { type: "text_delta"; messageId: string; text: string }
  | { type: "approval_card"; gateId: string; title: string; summary: string }
  | {
      type: "credential_card";
      reqId: string;
      conversationId: string;
      items: CredentialRequestItem[];
    }
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
  /** 配置后使用 HTTPS；证书链文件可选。 */
  https?: { certPath: string; keyPath: string; chainPath?: string };
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
  skillPackStore?: SkillPackStore;
  installer?: SkillInstaller;
  credentialStore?: CredentialStore;
  modelConfigStore?: UserModelConfigStore;
  agentStore?: AgentStore;
  agentShareStore?: AgentShareStore;
  gitConnectionStore?: GitConnectionStore;
  gitAuthProviders?: Partial<Record<GitProvider, GitAuthProviderAdapter>>;
  gitAccessGate?: GitAccessGate;
  /** 工作流模块（M14+M15+M6）—— 缺省=不支持 */
  triggerStore?: TriggerStore;
  workflowStore?: WorkflowStore;
  loopStore?: LoopStore;
  loopRunner?: LoopRunner;
  scheduler?: SchedulerService;
  hookRegistry?: HookRegistry;
  publicBaseUrl?: string;
  agentMeta?: { presets: LlmPreset[]; skillPaths: string[] };
  llm?: LLMConfig;
  llmDebugRunner?: LlmDebugRunner;
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
  private cancelHandler?: (conversationId: string) => boolean | Promise<boolean>;
  private server?: HttpServer | HttpsServer;
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
  private readonly agentStore?: AgentStore;
  private readonly agentShareStore?: AgentShareStore;
  private readonly agentMeta?: { presets: LlmPreset[]; skillPaths: string[] };
  private readonly dingtalkConfig?: { appKey: string; appSecret: string };
  private readonly oauthStateMap = new Map<string, number>();
  private readonly gitOAuthStates = new Map<
    string,
    { userId: string; provider: GitProvider; returnTo: string; expiresAt: number }
  >();

  constructor(private readonly deps: WebChannelDeps) {
    this.webRoot = deps.webRoot ?? join(__dirname, "..", "..", "web");
    this.workspaceDir = deps.workspaceDir;
    this.messageStore = deps.messageStore;
    this.sessionStore = deps.sessionStore;
    this.fileBrowser = deps.fileBrowser;
    this.agentStore = deps.agentStore;
    this.agentShareStore = deps.agentShareStore;
    this.agentMeta = deps.agentMeta;
    this.dingtalkConfig = deps.dingtalkConfig;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;

    const requestHandler = (req: HttpRequest, res: ServerResponse): Promise<void> =>
      this.handleHttp(req, res);
    const server = this.deps.https
      ? createHttpsServer(
          {
            key: readFileSync(this.deps.https.keyPath),
            cert: this.deps.https.chainPath
              ? Buffer.concat([
                  readFileSync(this.deps.https.certPath),
                  Buffer.from("\n"),
                  readFileSync(this.deps.https.chainPath),
                ])
              : readFileSync(this.deps.https.certPath),
          },
          requestHandler,
        )
      : createHttpServer(requestHandler);
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

  onCancel(handler: (conversationId: string) => boolean | Promise<boolean>): void {
    this.cancelHandler = handler;
  }

  /** 向会话的 SSE 客户端推送助手文本增量 */
  pushTextDelta(conversationId: string, messageId: string, text: string): void {
    this.broadcastToConversation(conversationId, { type: "text_delta", messageId, text });
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

  /** 存储凭证提交的 resolve 函数（key = credential reqId） */
  private readonly pendingCredentialResolves = new Map<
    string,
    (values: Record<string, string>) => void
  >();

  /** 等待用户提交凭证（通过 SSE credential_card + HTTP POST /api/credentials/:reqId/submit） */
  async requestCredentials(
    threadId: string,
    req: CredentialRequest,
  ): Promise<Record<string, string>> {
    void threadId;
    const reqId = crypto.randomUUID();
    this.broadcastToConversation(req.conversationId, {
      type: "credential_card",
      reqId,
      conversationId: req.conversationId,
      items: req.items,
    });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCredentialResolves.delete(reqId);
        reject(new Error("凭证提交超时（300秒）"));
      }, 300_000);
      this.pendingCredentialResolves.set(reqId, (values) => {
        clearTimeout(timeout);
        this.pendingCredentialResolves.delete(reqId);
        resolve(values);
      });
    });
  }

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

    // /hooks/* —— Hook 触发器入口，免认证（外部系统回调）
    if (url.startsWith("/hooks/")) {
      try {
        await this.handleHook(req, res);
      } catch (e) {
        // ponytail: 不向外部回调端点泄露内部错误细节；413 是体积超限的标准码可透露
        if (!res.headersSent) {
          const status = e instanceof PayloadTooLargeError ? 413 : 500;
          res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(status === 413 ? "payload too large" : "internal error");
        }
      }
      return;
    }

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
      // 凭证门提交
      if (url.startsWith("/api/credentials/") && req.method === "POST" && url.endsWith("/submit")) {
        await this.handleCredentialSubmit(url, req, res);
        return;
      }
      // 发送消息
      const sendMatch = url.match(/^\/api\/conversations\/([\w-]+)\/messages$/);
      if (sendMatch && req.method === "POST") {
        await this.handleSendMessage(req, res);
        return;
      }
      const cancelMatch = url.match(/^\/api\/conversations\/([\w-]+)\/cancel$/);
      if (cancelMatch && req.method === "POST") {
        const conversationId = cancelMatch[1];
        if (!conversationId) return this.json(res, { error: "invalid conversation url" }, 400);
        await this.handleCancel(req, res, conversationId);
        return;
      }
      // 其他 API
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      try {
        await this.handleApi(url, req, res);
      } catch (e) {
        this.writeApiError(res, e);
      }
      return;
    }

    // /uploads/ 静态文件
    if (url.startsWith("/uploads/")) {
      const relPath = decodeURIComponent(url.replace("/uploads/", ""));
      const [conversationId, ...fileParts] = relPath.split(/[\\/]/);
      const fileName = fileParts.join(sep);
      const attachmentDir = conversationId
        ? await this.resolveAttachmentDir(conversationId)
        : undefined;
      const candidate = attachmentDir ? resolve(attachmentDir, fileName) : "";
      const insideAttachmentDir =
        !!attachmentDir &&
        !!fileName &&
        (candidate === attachmentDir || candidate.startsWith(attachmentDir + sep));
      const legacyRoot = resolve(this.workspaceDir, "sessions");
      const legacyPath = resolve(legacyRoot, relPath);
      const insideLegacyRoot = legacyPath === legacyRoot || legacyPath.startsWith(legacyRoot + sep);
      const absPath =
        insideAttachmentDir && existsSync(candidate)
          ? candidate
          : insideLegacyRoot
            ? legacyPath
            : "";
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

  /** 凭证门提交：按 reqId 解析 pendingCredentialResolves，把 values 回传给 requestCredentials */
  private async handleCredentialSubmit(
    url: string,
    req: HttpRequest,
    res: ServerResponse,
  ): Promise<void> {
    const match = url.match(/^\/api\/credentials\/([\w-]+)\/submit$/);
    if (!match) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid credential url" }));
      return;
    }
    const reqId = match[1]!;
    const body = JSON.parse(await this.readBody(req)) as { values?: Record<string, string> };
    const resolve = this.pendingCredentialResolves.get(reqId);
    if (resolve) {
      resolve(body.values ?? {});
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "credential request not found or expired" }));
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
      files?: MessageFile[];
    };
    const parsedFiles = MessageFileSchema.array()
      .max(5)
      .safeParse(body.files ?? []);
    if (!parsedFiles.success) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "附件参数无效或超过 5 个" }));
      return;
    }
    const files = parsedFiles.data;
    const sessionRoot = await this.resolveAttachmentDir(
      conversationId,
      (req as HttpRequest & { userId?: string }).userId,
    );
    if (!sessionRoot) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "会话不存在或不属于当前用户" }));
      return;
    }
    const requestUserId = (req as HttpRequest & { userId?: string }).userId;
    if (requestUserId) {
      const gitAccess = await this.checkConversationGitAccess(requestUserId, conversationId);
      if (gitAccess && !gitAccess.ready) {
        this.json(
          res,
          { ready: false, code: "GIT_AUTH_REQUIRED", requirements: gitAccess.requirements },
          428,
        );
        return;
      }
    }
    const invalidFile = files.find((file) => {
      const path = resolve(file.path);
      return (!path.startsWith(sessionRoot + sep) && path !== sessionRoot) || !existsSync(path);
    });
    if (invalidFile) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: `附件不属于当前会话或不存在: ${invalidFile.name}` }));
      return;
    }

    // 持久化用户消息
    if (this.messageStore) {
      await this.messageStore
        .add(conversationId, "user", body.text, JSON.stringify(files))
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
        files,
      });
    }

    res.writeHead(202);
    res.end(JSON.stringify({ ok: true, conversationId }));
  }

  private async handleCancel(
    req: HttpRequest,
    res: ServerResponse,
    conversationId: string,
  ): Promise<void> {
    if (this.sessionStore) {
      const userId = await this.authMiddleware(req);
      if (!userId) return this.json(res, { error: "unauthorized" }, 401);
      const conversation = await this.deps.conversationStore?.get(conversationId);
      if (conversation && conversation.userId !== userId) {
        return this.json(res, { error: "forbidden" }, 403);
      }
    }
    const canceled = (await this.cancelHandler?.(conversationId)) ?? false;
    this.json(res, { ok: canceled }, canceled ? 200 : 409);
  }

  // ---------------------------------------------------------------------------
  // 原有 API 路由
  // ---------------------------------------------------------------------------

  private async handleApi(url: string, req: HttpRequest, res: ServerResponse): Promise<void> {
    // 免认证路由
    const publicRoutes = [
      "/api/auth/qrcode-url",
      "/api/auth/dingtalk/callback",
      "/api/agents/by-share",
      "/api/settings/git/oauth/",
      "/api/health",
    ];
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

    // === 用户 Git 配置 / OAuth 路由 ===
    const gitCallbackMatch = url.match(
      /^\/api\/settings\/git\/oauth\/(github|gitee|jihulab)\/callback(?:\?|$)/,
    );
    if (gitCallbackMatch && req.method === "GET") {
      await this.handleGitOAuthCallback(req, res, gitCallbackMatch[1] as GitProvider);
      return;
    }

    if (url === "/api/settings/git/connections" && req.method === "GET") {
      const userId = this.requireRequestUser(req);
      const connections = (await this.deps.gitConnectionStore?.listByUser(userId)) ?? [];
      this.json(res, {
        connections,
        oauthConfigured: Object.fromEntries(
          (["github", "gitee", "jihulab"] as GitProvider[]).map((provider) => [
            provider,
            this.deps.gitAuthProviders?.[provider]?.oauthConfigured ?? false,
          ]),
        ),
      });
      return;
    }

    const gitAuthorizeMatch = url.match(
      /^\/api\/settings\/git\/(github|gitee|jihulab)\/authorize$/,
    );
    if (gitAuthorizeMatch && req.method === "POST") {
      const userId = this.requireRequestUser(req);
      const provider = gitAuthorizeMatch[1] as GitProvider;
      const adapter = this.requireGitProvider(provider);
      const body = JSON.parse(await this.readBody(req)) as { returnTo?: string };
      const state = crypto.randomUUID();
      const returnTo = body.returnTo?.startsWith("/") ? body.returnTo : "/settings/git";
      this.gitOAuthStates.set(state, {
        userId,
        provider,
        returnTo,
        expiresAt: Date.now() + 10 * 60_000,
      });
      this.json(res, { authorizeUrl: adapter.getAuthorizationUrl(state) });
      return;
    }

    const gitPatMatch = url.match(/^\/api\/settings\/git\/(github|gitee|jihulab)\/pat$/);
    if (gitPatMatch && req.method === "POST") {
      const userId = this.requireRequestUser(req);
      const provider = gitPatMatch[1] as GitProvider;
      const adapter = this.requireGitProvider(provider);
      const body = JSON.parse(await this.readBody(req)) as { token?: string };
      const authorization = await adapter.verifyPat(body.token ?? "");
      const existing = await this.deps.gitConnectionStore?.getDefault(userId, provider);
      const connection = await this.requireGitConnectionStore().save({
        id: existing?.id,
        userId,
        provider,
        ...authorization,
      });
      this.json(res, { connection }, 201);
      return;
    }

    const gitDeleteMatch = url.match(/^\/api\/settings\/git\/connections\/([\w-]+)$/);
    if (gitDeleteMatch && req.method === "DELETE") {
      await this.requireGitConnectionStore().delete(
        gitDeleteMatch[1] ?? "",
        this.requireRequestUser(req),
      );
      this.json(res, { ok: true });
      return;
    }

    const preflightMatch = url.match(/^\/api\/conversations\/([\w-]+)\/preflight$/);
    if (preflightMatch && req.method === "GET") {
      const result = await this.checkConversationGitAccess(
        this.requireRequestUser(req),
        preflightMatch[1] ?? "",
      );
      this.json(res, result ?? { ready: true, requirements: [] });
      return;
    }

    const grantsMatch = url.match(/^\/api\/conversations\/([\w-]+)\/git-grants$/);
    if (grantsMatch && req.method === "POST") {
      const userId = this.requireRequestUser(req);
      const context = await this.resolveGitConversationContext(userId, grantsMatch[1] ?? "");
      if (!context) throw new NotFoundError("AGENT_NOT_FOUND", "会话未绑定智能体");
      const body = JSON.parse(await this.readBody(req)) as { repositoryIds?: string[] };
      const result = await this.requireGitAccessGate().grantRepositories(
        context.user,
        context.agent,
        body.repositoryIds ?? [],
      );
      this.json(res, result);
      return;
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
      const redirectUri = `${this.oauthBaseUrl()}/api/auth/dingtalk/callback`;
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

    // GET/PUT /api/settings/models：用户级 Claude Agent 模型配置
    if (url === "/api/settings/models" && (req.method === "GET" || req.method === "PUT")) {
      const userId = this.requireRequestUser(req);
      const store = this.deps.modelConfigStore;
      if (!store) return this.json(res, { error: "模型配置服务未启用" }, 503);

      if (req.method === "GET") {
        const config = await store.get(userId);
        const fallbackModels = [
          ...(this.agentMeta?.presets.map((preset) => preset.model) ?? []),
          this.deps.llm?.model,
        ].filter((model): model is string => Boolean(model));
        const defaults: UserModelConfig | undefined = this.deps.llm
          ? {
              url: this.deps.llm.baseUrl,
              key: this.deps.llm.authToken,
              models: [...new Set(fallbackModels)],
              defaultModel: this.deps.llm.model,
            }
          : undefined;
        const current = config ?? defaults;
        if (!current) return this.json(res, { error: "默认模型配置未就绪" }, 503);
        return this.json(res, {
          url: current.url,
          models: current.models,
          defaultModel: current.defaultModel,
          keyConfigured: Boolean(current.key),
        });
      }

      const body = JSON.parse(await this.readBody(req)) as {
        url?: unknown;
        key?: unknown;
        models?: unknown;
        defaultModel?: unknown;
      };
      const existing = await store.get(userId);
      const key =
        typeof body.key === "string" && body.key.trim()
          ? body.key.trim()
          : (existing?.key ?? this.deps.llm?.authToken ?? "");
      try {
        const config = parseUserModelConfig({
          url: body.url,
          key,
          models: body.models,
          defaultModel: body.defaultModel,
        });
        await store.save(userId, config);
        return this.json(res, {
          url: config.url,
          models: config.models,
          defaultModel: config.defaultModel,
          keyConfigured: true,
        });
      } catch (error) {
        return this.json(
          res,
          { error: error instanceof Error ? error.message : "模型配置无效" },
          400,
        );
      }
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
      const { userId, channelId, agentId } = JSON.parse(body) as {
        userId: string;
        channelId?: string;
        agentId?: string;
      };
      if (userId && this.deps.userStore) {
        const user = await this.deps.userStore.get(userId);
        if (!user) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "user not found" }));
          return;
        }
      }
      const conv = agentId
        ? await this.deps.conversationStore?.createWithAgent(
            userId,
            channelId ?? "web",
            "新对话",
            agentId,
          )
        : await this.deps.conversationStore?.create(userId, channelId ?? "web", "新对话");
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

    // POST /api/llm/debug：用已配置模型对编辑后的历史输入做隔离调试调用
    if (url === "/api/llm/debug" && req.method === "POST") {
      const body = JSON.parse(await this.readBody(req)) as {
        input?: unknown;
        presetId?: unknown;
      };
      if (typeof body.input !== "string" || !body.input.trim()) {
        this.json(res, { error: "input is required" }, 400);
        return;
      }
      if (!this.deps.llm || !this.deps.llmDebugRunner) {
        this.json(res, { error: "LLM debug runner is not configured" }, 503);
        return;
      }
      const presetId = typeof body.presetId === "string" ? body.presetId : undefined;
      const preset = presetId
        ? this.agentMeta?.presets.find((item) => item.id === presetId)
        : undefined;
      if (presetId && !preset) {
        this.json(res, { error: "unknown LLM preset" }, 400);
        return;
      }
      const llm = preset
        ? { ...this.deps.llm, model: preset.model, baseUrl: preset.baseUrl }
        : this.deps.llm;
      const result = await this.deps.llmDebugRunner.run(body.input, llm);
      this.json(res, { ...result, model: llm.model }, 200);
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

    // === Agent 路由 ===
    if (url === "/api/agents" && req.method === "GET") {
      const me = this.requireUserId(req);
      const mine = (await this.agentStore?.listByOwner(me)) ?? [];
      const shared = (await this.agentStore?.listSharedWith(me)) ?? [];
      const seen = new Set<string>();
      const out: Array<Record<string, unknown> & { id: string; _mine: boolean }> = [
        ...mine.map((a) => ({ ...this.agentToDTO(a, true), id: a.id, _mine: true })),
        ...shared.map((a) => ({ ...this.agentToDTO(a, true), id: a.id, _mine: false })),
      ];
      const deduped = out.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
      return this.json(res, deduped);
    }
    if (url === "/api/agents" && req.method === "POST") {
      const me = this.requireUserId(req);
      const body = JSON.parse(await this.readBody(req));
      const input = parseAgentInput({ ...body, ownerId: me });
      const created = await this.agentStore!.create(input);
      return this.json(res, this.agentToDTO(created, true), 201);
    }
    if (url === "/api/agents/meta/options" && req.method === "GET") {
      const userId = this.requireUserId(req);
      return this.json(res, {
        skills: await this.discoverAgentSkills(userId),
        tools: BUILTIN_TOOLS,
        llmPresets: this.agentMeta?.presets ?? [],
      });
    }
    const agentMatch = url.match(/^\/api\/agents\/([\w-]+)$/);
    if (
      agentMatch &&
      !url.includes("/share/") &&
      !url.includes("/conversation") &&
      !url.includes("/accept-share") &&
      !url.includes("/by-share")
    ) {
      const id = agentMatch[1]!;
      const me = this.requireUserId(req);
      const a = await this.agentStore?.get(id);
      if (!a) return this.json(res, { error: "not found" }, 404);
      const meUser = await this.deps.userStore?.get(me);
      const actor = { id: me, role: (meUser?.role ?? "user") as "admin" | "user" };
      const granted = this.agentShareStore ? await this.agentShareStore.isGranted(id, me) : false;
      if (!canUseAgent(a, actor, granted)) return this.json(res, { error: "forbidden" }, 403);
      if (req.method === "GET") {
        const editable = canManageAgent(a, actor);
        return this.json(res, { ...this.agentToDTO(a, editable), editable });
      }
      if (req.method === "PATCH") {
        if (!canManageAgent(a, actor)) return this.json(res, { error: "forbidden" }, 403);
        const patch = JSON.parse(await this.readBody(req)) as Partial<Agent>;
        const updated = await this.agentStore!.update(id, this.mergeMaskedMcp(a, patch));
        return this.json(res, this.agentToDTO(updated, true));
      }
      if (req.method === "DELETE") {
        if (!canManageAgent(a, actor)) return this.json(res, { error: "forbidden" }, 403);
        await this.agentStore!.delete(id);
        res.writeHead(204);
        res.end();
        return;
      }
    }
    const agentConvMatch = url.match(/^\/api\/agents\/([\w-]+)\/conversation$/);
    if (agentConvMatch && req.method === "GET") {
      const id = agentConvMatch[1]!;
      const me = this.requireUserId(req);
      const a = await this.agentStore?.get(id);
      if (!a) return this.json(res, { error: "not found" }, 404);
      const meUser = await this.deps.userStore?.get(me);
      const actor = { id: me, role: (meUser?.role ?? "user") as "admin" | "user" };
      const granted = this.agentShareStore ? await this.agentShareStore.isGranted(id, me) : false;
      if (!canUseAgent(a, actor, granted)) return this.json(res, { error: "forbidden" }, 403);
      const list = (await this.deps.conversationStore?.listByUser(me)) ?? [];
      const existing = list.find((c) => c.agentId === id);
      const conv =
        existing ?? (await this.deps.conversationStore?.createWithAgent(me, "web", a.name, id));
      return this.json(res, conv);
    }

    // === 分享路由 ===
    const shareMatch = url.match(/^\/api\/agents\/([\w-]+)\/share$/);
    if (shareMatch) {
      const sid = shareMatch[1]!;
      const me = this.requireUserId(req);
      const a = await this.agentStore?.get(sid);
      if (!a) return this.json(res, { error: "not found" }, 404);
      const meUser = await this.deps.userStore?.get(me);
      const actor = { id: me, role: (meUser?.role ?? "user") as "admin" | "user" };
      if (!canManageAgent(a, actor)) return this.json(res, { error: "forbidden" }, 403);
      if (req.method === "GET") {
        const share = await this.agentShareStore?.getShare(sid);
        const grants = share?.enabled ? ((await this.agentShareStore?.listGrants(sid)) ?? []) : [];
        return this.json(res, {
          enabled: !!share?.enabled,
          token: share?.token,
          url: share?.token ? `/share/${share.token}` : null,
          grants,
        });
      }
      if (req.method === "POST") {
        const { enabled } = JSON.parse(await this.readBody(req)) as { enabled: boolean };
        if (enabled) {
          const s = await this.agentShareStore!.enableShare(sid);
          return this.json(res, { enabled: true, token: s.token, url: `/share/${s.token}` });
        }
        await this.agentShareStore!.disableShare(sid);
        return this.json(res, { enabled: false, token: null, url: null });
      }
    }
    const removeGrantMatch = url.match(/^\/api\/agents\/([\w-]+)\/share\/grants\/([\w-]+)$/);
    if (removeGrantMatch && req.method === "DELETE") {
      const sid = removeGrantMatch[1]!;
      const grantUserId = removeGrantMatch[2]!;
      const me = this.requireUserId(req);
      const a = await this.agentStore?.get(sid);
      if (!a) return this.json(res, { error: "not found" }, 404);
      const meUser = await this.deps.userStore?.get(me);
      const actor = { id: me, role: (meUser?.role ?? "user") as "admin" | "user" };
      if (!canManageAgent(a, actor)) return this.json(res, { error: "forbidden" }, 403);
      await this.agentShareStore!.removeGrant(sid, grantUserId);
      return this.json(res, { ok: true });
    }
    // 公开：by-share（不泄配置）
    const byShareMatch = url.match(/^\/api\/agents\/by-share\/([\w-]+)$/);
    if (byShareMatch && req.method === "GET") {
      const ref = await this.agentShareStore?.findByToken(byShareMatch[1]!);
      if (!ref || !ref.enabled) return this.json(res, { error: "not found" }, 404);
      const a = await this.agentStore?.get(ref.agentId);
      if (!a) return this.json(res, { error: "not found" }, 404);
      return this.json(res, {
        agentId: a.id,
        name: a.name,
        description: a.description,
        requiresLogin: true,
      });
    }
    // 已登录：accept-share → 幂等 addGrant + get-or-create 会话
    const acceptMatch = url.match(/^\/api\/agents\/([\w-]+)\/accept-share$/);
    if (acceptMatch && req.method === "POST") {
      const sid = acceptMatch[1]!;
      const me = this.requireUserId(req);
      const { token } = JSON.parse(await this.readBody(req)) as { token: string };
      const ref = await this.agentShareStore?.findByToken(token);
      if (!ref || !ref.enabled || ref.agentId !== sid) {
        return this.json(res, { error: "invalid token" }, 403);
      }
      await this.agentShareStore!.addGrant(sid, me);
      const list = (await this.deps.conversationStore?.listByUser(me)) ?? [];
      const existing = list.find((c) => c.agentId === sid);
      const a = await this.agentStore?.get(sid);
      const conv =
        existing ??
        (await this.deps.conversationStore?.createWithAgent(me, "web", a?.name ?? "新对话", sid));
      return this.json(res, { conversation: conv });
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

    if (await this.handleSkillsApi(url, req, res)) return;

    if (await this.handleWorkflowApi(url, req, res)) return;

    res.writeHead(404);
    res.end(JSON.stringify({ error: "unknown endpoint" }));
  }

  /** 工作流模块资源所有权校验：不存在或不属于该用户均抛 NotFoundError（避免存在性泄露）。 */
  private async requireOwnedTrigger(id: string, uid: string): Promise<Trigger> {
    const t = await this.deps.triggerStore!.get(id);
    if (!t?.ownerId || t.ownerId !== uid) {
      throw new NotFoundError("NOT_FOUND", "trigger 不存在");
    }
    return t;
  }

  private async requireOwnedWorkflow(id: string, uid: string): Promise<Workflow> {
    const w = await this.deps.workflowStore!.get(id);
    if (!w?.ownerId || w.ownerId !== uid) {
      throw new NotFoundError("NOT_FOUND", "workflow 不存在");
    }
    return w;
  }

  private async requireOwnedLoop(id: string, uid: string): Promise<Loop> {
    const l = await this.deps.loopStore!.get(id);
    if (!l?.ownerId || l.ownerId !== uid) throw new NotFoundError("NOT_FOUND", "loop 不存在");
    return l;
  }

  /** AppError 子类 → HTTP 状态码映射（缺省 500）。 */
  private writeApiError(res: ServerResponse, e: unknown): void {
    let status = 500;
    if (e instanceof ForbiddenError) status = 403;
    else if (e instanceof NotFoundError) status = 404;
    else if (e instanceof ValidationError) status = 400;
    else if (e instanceof PayloadTooLargeError) status = 413;
    else if (e instanceof SyntaxError) status = 400;
    else if (e instanceof ZodError) status = 400;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }

  /** POST /hooks/<slug> —— Hook 触发器入口，免认证。 */
  private async handleHook(req: HttpRequest, res: ServerResponse): Promise<void> {
    if (!this.deps.hookRegistry) {
      res.writeHead(404);
      res.end("hooks disabled");
      return;
    }
    const body = await this.readBody(req);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(",");
    }
    const result = await this.deps.hookRegistry.handle({
      method: req.method,
      url: req.url,
      headers,
      body,
    });
    res.writeHead(result.status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(result.body);
  }

  /**
   * 工作流模块 API（triggers / workflows / loops）。命中返回 true。
   * ponytail: 单文件聚合所有 CRUD 路由，避免拆多文件多 handler。
   */
  private async handleWorkflowApi(
    url: string,
    req: HttpRequest,
    res: ServerResponse,
  ): Promise<boolean> {
    const pathname = url.split("?")[0] ?? url;
    const ts = this.deps.triggerStore;
    const ws = this.deps.workflowStore;
    const ls = this.deps.loopStore;
    // 三者全缺省直接放行（路由不适用）
    if (!ts && !ws && !ls) return false;
    const uid = this.requireRequestUser(req);

    // ===== Triggers =====
    if (pathname === "/api/triggers" && req.method === "GET") {
      this.json(res, { triggers: await ts!.listByOwner(uid) });
      return true;
    }
    if (pathname === "/api/triggers" && req.method === "POST") {
      const body = JSON.parse(await this.readBody(req));
      const created = await ts!.create(parseTriggerInput({ ...body, ownerId: uid }));
      this.json(res, created, 201);
      return true;
    }
    let m = pathname.match(/^\/api\/triggers\/([\w-]+)$/);
    if (m && req.method === "GET") {
      this.json(res, await this.requireOwnedTrigger(m[1]!, uid));
      return true;
    }
    if (m && req.method === "PUT") {
      // PUT = 全量替换：parseTriggerInput 要求完整对象（name/type/scheduler|hook 等），缺字段返回 400。
      // store.update 签名虽为 Partial<>，但 HTTP 层强制客户端发全量；如需部分更新请新增 PATCH 路由。
      await this.requireOwnedTrigger(m[1]!, uid);
      const body = JSON.parse(await this.readBody(req));
      const updated = await ts!.update(m[1]!, parseTriggerInput({ ...body, ownerId: uid }));
      // ponytail: trigger cron 可能变更，刷新所有引用此 trigger 的 enabled loops
      await this.deps.scheduler?.refreshByTrigger(m[1]!);
      this.json(res, updated);
      return true;
    }
    if (m && req.method === "DELETE") {
      await this.requireOwnedTrigger(m[1]!, uid);
      const count = await ts!.countWorkflowsReferencing(m[1]!);
      if (count > 0) {
        this.json(res, { error: `被 ${count} 个 workflow 引用，无法删除` }, 409);
        return true;
      }
      await ts!.delete(m[1]!);
      this.json(res, { ok: true });
      return true;
    }
    m = pathname.match(/^\/api\/triggers\/([\w-]+)\/test$/);
    if (m && req.method === "POST" && this.deps.loopRunner) {
      await this.requireOwnedTrigger(m[1]!, uid);
      const result = await this.deps.loopRunner.testTrigger(m[1]!);
      this.json(res, result);
      return true;
    }

    // ===== Workflows =====
    if (pathname === "/api/workflows" && req.method === "GET") {
      this.json(res, { workflows: await ws!.listByOwner(uid) });
      return true;
    }
    if (pathname === "/api/workflows" && req.method === "POST") {
      const body = JSON.parse(await this.readBody(req));
      const created = await ws!.create(parseWorkflowInput({ ...body, ownerId: uid }));
      this.json(res, created, 201);
      return true;
    }
    m = pathname.match(/^\/api\/workflows\/([\w-]+)$/);
    if (m && req.method === "GET") {
      this.json(res, await this.requireOwnedWorkflow(m[1]!, uid));
      return true;
    }
    if (m && req.method === "PUT") {
      // PUT = 全量替换：parseWorkflowInput 要求完整对象（name/triggerId/agentId 等）。
      await this.requireOwnedWorkflow(m[1]!, uid);
      const body = JSON.parse(await this.readBody(req));
      const updated = await ws!.update(m[1]!, parseWorkflowInput({ ...body, ownerId: uid }));
      this.json(res, updated);
      return true;
    }
    if (m && req.method === "DELETE") {
      await this.requireOwnedWorkflow(m[1]!, uid);
      await ws!.delete(m[1]!);
      this.json(res, { ok: true });
      return true;
    }

    // ===== Loops =====
    if (pathname === "/api/loops" && req.method === "GET") {
      this.json(res, { loops: await ls!.listByOwner(uid) });
      return true;
    }
    if (pathname === "/api/loops" && req.method === "POST") {
      const body = JSON.parse(await this.readBody(req));
      const created = await ls!.create(parseLoopInput({ ...body, ownerId: uid }));
      this.json(res, created, 201);
      return true;
    }
    m = pathname.match(/^\/api\/loops\/([\w-]+)$/);
    if (m && req.method === "GET") {
      this.json(res, await this.requireOwnedLoop(m[1]!, uid));
      return true;
    }
    if (m && req.method === "PUT") {
      // PUT = 全量替换：parseLoopInput 要求完整对象（name/workflowId 等）。
      await this.requireOwnedLoop(m[1]!, uid);
      const body = JSON.parse(await this.readBody(req));
      const updated = await ls!.update(m[1]!, parseLoopInput({ ...body, ownerId: uid }));
      this.json(res, updated);
      return true;
    }
    if (m && req.method === "DELETE") {
      await this.requireOwnedLoop(m[1]!, uid);
      await ls!.delete(m[1]!);
      this.json(res, { ok: true });
      return true;
    }
    m = pathname.match(/^\/api\/loops\/([\w-]+)\/(enable|disable)$/);
    if (m && req.method === "POST") {
      await this.requireOwnedLoop(m[1]!, uid);
      const enabled = m[2] === "enable";
      const loop = await ls!.setEnabled(m[1]!, enabled);
      // 启停时同步调度器
      if (this.deps.scheduler) {
        if (enabled) await this.deps.scheduler.register(loop);
        else this.deps.scheduler.unregister(loop.id);
      }
      this.json(res, loop);
      return true;
    }
    m = pathname.match(/^\/api\/loops\/([\w-]+)\/run$/);
    if (m && req.method === "POST" && this.deps.loopRunner) {
      // 手动触发：取 workflow 关联的 trigger 一次性测试+fire
      const loop = await this.requireOwnedLoop(m[1]!, uid);
      const wf = loop.workflowId ? await ws!.get(loop.workflowId) : undefined;
      if (!wf?.triggerId) {
        throw new ValidationError("WORKFLOW_NO_TRIGGER", "workflow 未配置 trigger");
      }
      const result = await this.deps.loopRunner.testTrigger(wf.triggerId);
      await this.deps.loopRunner.fire(loop.id, result.sourceOutput);
      this.json(res, { ok: true, matched: result.matched, sourceOutput: result.sourceOutput });
      return true;
    }
    m = pathname.match(/^\/api\/loops\/([\w-]+)\/runs$/);
    if (m && req.method === "GET") {
      await this.requireOwnedLoop(m[1]!, uid);
      const runs = await ls!.listRuns(m[1]!, { limit: 50 });
      this.json(res, { runs });
      return true;
    }
    return false;
  }

  /** 技能/凭证 API 命中返回 true。委托 skill-api handler。 */
  private async handleSkillsApi(
    url: string,
    req: HttpRequest,
    res: ServerResponse,
  ): Promise<boolean> {
    const deps = this.skillDeps();
    const uid = (req as HttpRequest & { userId?: string }).userId ?? "";
    const match = (re: RegExp): RegExpMatchArray | null => url.match(re);
    const send = (r: { status: number; json: unknown }) => {
      res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r.json));
    };
    if (!deps) return false;

    if (url === "/api/skills/packs" && req.method === "GET") {
      send(await handleListPacks(uid, {}, deps));
      return true;
    }
    if (url === "/api/skills/packs/install" && req.method === "POST") {
      send(await handleInstall(uid, JSON.parse(await this.readBody(req)), deps));
      return true;
    }
    if (url === "/api/skills/packs/install/upload" && req.method === "POST") {
      send(await handleInstallUpload(uid, JSON.parse(await this.readBody(req)), deps));
      return true;
    }
    if (url === "/api/skills/packs/update" && req.method === "POST") {
      send(await handleUpdate(uid, JSON.parse(await this.readBody(req)), deps));
      return true;
    }
    if (url === "/api/skills/packs/uninstall" && req.method === "POST") {
      send(await handleUninstall(uid, JSON.parse(await this.readBody(req)), deps));
      return true;
    }
    if (url === "/api/skills/packs/enable" && req.method === "POST") {
      const b = JSON.parse(await this.readBody(req)) as { id: string };
      send(await handleSetPackEnabled(uid, { id: b.id, enabled: true }, deps));
      return true;
    }
    if (url === "/api/skills/packs/disable" && req.method === "POST") {
      const b = JSON.parse(await this.readBody(req)) as { id: string };
      send(await handleSetPackEnabled(uid, { id: b.id, enabled: false }, deps));
      return true;
    }
    if (url === "/api/skills/skills/enable" && req.method === "POST") {
      const b = JSON.parse(await this.readBody(req)) as { id: string };
      send(await handleSetSkillEnabled(uid, { id: b.id, enabled: true }, deps));
      return true;
    }
    if (url === "/api/skills/skills/disable" && req.method === "POST") {
      const b = JSON.parse(await this.readBody(req)) as { id: string };
      send(await handleSetSkillEnabled(uid, { id: b.id, enabled: false }, deps));
      return true;
    }
    if (url === "/api/credentials" && req.method === "GET") {
      send(await handleListCredentials(uid, {}, deps));
      return true;
    }
    const credMatch = match(/^\/api\/credentials\/([^/]+)$/);
    if (credMatch && req.method === "PUT") {
      const b = JSON.parse(await this.readBody(req)) as { value: string; label?: string };
      send(await handleSetCredential(uid, { key: decodeURIComponent(credMatch[1]!), ...b }, deps));
      return true;
    }
    if (credMatch && req.method === "DELETE") {
      send(await handleDeleteCredential(uid, { key: decodeURIComponent(credMatch[1]!) }, deps));
      return true;
    }
    return false;
  }

  /** 组装 skill-api 依赖；任一缺失返回 null（路由回 404）。 */
  private skillDeps(): SkillApiDeps | null {
    const { skillPackStore, installer, credentialStore } = this.deps;
    if (!skillPackStore || !installer || !credentialStore) return null;
    return { packStore: skillPackStore, installer, credentialStore };
  }

  /** GET /api/files/tree?scope=user|runtime|extension[&conversationId=] */
  private async handleFileTree(req: HttpRequest, res: ServerResponse): Promise<void> {
    if (!this.fileBrowser) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "文件浏览未启用" }));
      return;
    }
    const userId = (req as HttpRequest & { userId?: string }).userId ?? "";
    const scope = this.extractQuery(req.url ?? "", "scope");
    const conversationId = this.extractQuery(req.url ?? "", "conversationId");
    if (scope !== "user" && scope !== "runtime" && scope !== "extension") {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "scope 必须是 user、runtime 或 extension" }));
      return;
    }
    if (scope !== "user" && !conversationId) {
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
    if (scope !== "user" && scope !== "runtime" && scope !== "extension") {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "scope 必须是 user、runtime 或 extension" }));
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

    const sessionDir = await this.resolveAttachmentDir(
      threadId,
      (req as HttpRequest & { userId?: string }).userId,
    );
    if (!sessionDir) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "会话不存在或不属于当前用户" }));
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
          const filename = basename(info.filename);
          const { mimeType } = info;
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

  private async resolveAttachmentDir(
    conversationId: string,
    expectedUserId?: string,
  ): Promise<string | undefined> {
    if (this.deps.conversationStore && this.deps.userStore) {
      const conversation = await this.deps.conversationStore.get(conversationId);
      if (!conversation || (expectedUserId && conversation.userId !== expectedUserId)) {
        return undefined;
      }
      const user = await this.deps.userStore.get(conversation.userId);
      if (!user) return undefined;
      return resolve(user.homeDir, "sessions", conversationId, "workspace", "attachments");
    }
    return resolve(this.workspaceDir, "sessions", conversationId);
  }

  private extractQuery(url: string, key: string): string | undefined {
    const u = new URL(url, "http://localhost");
    return u.searchParams.get(key) ?? undefined;
  }

  private readBody(req: HttpRequest, maxBytes = 2 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk;
        // ponytail: 2MB 默认上限——JSON 配置远低于此，文件上传走 PUT /api/files/* 不经此路径
        if (Buffer.byteLength(body) > maxBytes) {
          req.destroy();
          reject(new PayloadTooLargeError("PAYLOAD_TOO_LARGE", `请求体超过 ${maxBytes} 字节上限`));
        }
      });
      req.on("end", () => resolve(body));
    });
  }

  /** 取已鉴权用户 id；未鉴权抛错（由调用方转 HTTP 状态） */
  private requireUserId(req: HttpRequest): string {
    const uid = (req as HttpRequest & { userId?: string }).userId;
    if (!uid) throw new Error("unauthorized");
    return uid;
  }

  private async discoverAgentSkills(
    userId: string,
  ): Promise<Array<{ id: string; name: string; description?: string }>> {
    const skills = discoverSkills(this.agentMeta?.skillPaths ?? []);
    const enabledSkills = this.deps.skillPackStore
      ? await this.deps.skillPackStore.listEnabledSkillsWithPack(userId)
      : [];
    const options = [
      ...skills,
      ...enabledSkills.map(({ skill, pack }) => ({
        id: `${pack.name}:${skill.name}`,
        name: skill.name,
        description: skill.description,
      })),
    ];
    const seen = new Set<string>();
    return options.filter((option) => {
      if (seen.has(option.id)) return false;
      seen.add(option.id);
      return true;
    });
  }

  /** 写 JSON 响应 */
  private json(res: ServerResponse, body: unknown, status = 200): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  /** Agent → DTO；detailed=false 时隐藏配置明细，env/headers 永远掩码 */
  private agentToDTO(a: Agent, detailed: boolean): Record<string, unknown> {
    const base: Record<string, unknown> = {
      id: a.id,
      ownerId: a.ownerId,
      name: a.name,
      description: a.description,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
    const maskedMcp = a.mcpServers.map((m) => ({
      ...m,
      env: m.env ? this.maskRecord(m.env) : undefined,
      headers: m.headers ? this.maskRecord(m.headers) : undefined,
    }));
    if (!detailed) return base;
    return {
      ...base,
      systemPrompt: a.systemPrompt,
      skills: a.skills,
      defaultSkill: a.defaultSkill,
      tools: a.tools,
      mcpServers: maskedMcp,
      gitRepositories: a.gitRepositories,
      extensionDirectories: a.extensionDirectories,
      llm: a.llm,
    };
  }

  private maskRecord(rec: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.keys(rec).map((k) => [k, "••••"]));
  }

  /** 编辑器回传掩码占位时，用库内原密文值回填 */
  private mergeMaskedMcp(a: Agent, patch: Partial<Agent>): Partial<Agent> {
    if (!patch.mcpServers) return patch;
    return {
      ...patch,
      mcpServers: patch.mcpServers.map((m, i) => {
        const orig = a.mcpServers[i];
        if (!orig) return m;
        const env = m.env && Object.values(m.env).some((v) => v === "••••") ? orig.env : m.env;
        const headers =
          m.headers && Object.values(m.headers).some((v) => v === "••••")
            ? orig.headers
            : m.headers;
        return { ...m, env, headers };
      }),
    };
  }

  private async handleGitOAuthCallback(
    req: HttpRequest,
    res: ServerResponse,
    provider: GitProvider,
  ): Promise<void> {
    const requestUrl = new URL(req.url ?? "", "http://localhost");
    const stateKey = requestUrl.searchParams.get("state") ?? "";
    const code = requestUrl.searchParams.get("code") ?? "";
    const state = this.gitOAuthStates.get(stateKey);
    this.gitOAuthStates.delete(stateKey);
    if (!state || state.provider !== provider || state.expiresAt <= Date.now() || !code) {
      this.json(res, { error: "Git OAuth state 或 code 无效" }, 400);
      return;
    }
    const authorization = await this.requireGitProvider(provider).exchangeCode(code);
    const store = this.requireGitConnectionStore();
    const existing = await store.getDefault(state.userId, provider);
    await store.save({ id: existing?.id, userId: state.userId, provider, ...authorization });
    const separator = state.returnTo.includes("?") ? "&" : "?";
    const relative = `${state.returnTo}${separator}gitConnected=${provider}`;
    const location = this.deps.publicBaseUrl
      ? new URL(relative, `${this.deps.publicBaseUrl}/`).toString()
      : relative;
    res.writeHead(302, { Location: location });
    res.end();
  }

  private requireRequestUser(req: HttpRequest): string {
    const userId = (req as HttpRequest & { userId?: string }).userId;
    if (!userId) throw new ForbiddenError("AUTH_REQUIRED", "请先登录");
    return userId;
  }

  private oauthBaseUrl(): string {
    const publicBaseUrl = this.deps.publicBaseUrl?.replace(/\/+$/, "");
    if (publicBaseUrl) return publicBaseUrl;
    const rawHost = this.deps.host ?? "localhost";
    const host = rawHost.includes(":") && !rawHost.startsWith("[") ? `[${rawHost}]` : rawHost;
    const port = this.boundPort ?? this.deps.port;
    return `${this.deps.https ? "https" : "http"}://${host}:${port}`;
  }

  private requireGitProvider(provider: GitProvider): GitAuthProviderAdapter {
    const adapter = this.deps.gitAuthProviders?.[provider];
    if (!adapter) throw new NotFoundError("GIT_PROVIDER_MISSING", `${provider} 鉴权未装配`);
    return adapter;
  }

  private requireGitConnectionStore(): GitConnectionStore {
    if (!this.deps.gitConnectionStore) {
      throw new NotFoundError("GIT_STORE_MISSING", "Git 连接存储未装配");
    }
    return this.deps.gitConnectionStore;
  }

  private requireGitAccessGate(): GitAccessGate {
    if (!this.deps.gitAccessGate) throw new NotFoundError("GIT_GATE_MISSING", "Git 权限门未装配");
    return this.deps.gitAccessGate;
  }

  private async checkConversationGitAccess(
    userId: string,
    conversationId: string,
  ): Promise<GitAccessCheck | undefined> {
    if (!this.deps.gitAccessGate) return undefined;
    const context = await this.resolveGitConversationContext(userId, conversationId);
    if (!context || context.agent.gitRepositories.length === 0) return undefined;
    return this.deps.gitAccessGate.check(context.user, context.agent);
  }

  private async resolveGitConversationContext(
    userId: string,
    conversationId: string,
  ): Promise<{ user: User; agent: Agent } | undefined> {
    const conversation = await this.deps.conversationStore?.get(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new ForbiddenError("CONVERSATION_FORBIDDEN", "会话不存在或不属于当前用户");
    }
    if (!conversation.agentId) return undefined;
    const user = await this.deps.userStore?.get(userId);
    const agent = await this.deps.agentStore?.get(conversation.agentId);
    if (!user || !agent) throw new NotFoundError("AGENT_NOT_FOUND", "智能体不存在");
    const granted = this.deps.agentShareStore
      ? await this.deps.agentShareStore.isGranted(agent.id, user.id)
      : false;
    if (!canUseAgent(agent, user, granted)) {
      throw new ForbiddenError("AGENT_FORBIDDEN", "无权使用该智能体");
    }
    return { user, agent };
  }

  /** 等 HTTP 服务监听就绪 */
  async ready(): Promise<void> {
    await this.readyPromise;
  }

  get boundPort(): number | undefined {
    const addr = this.server?.address();
    return typeof addr === "object" && addr ? addr.port : undefined;
  }

  /**
   * 关闭 HTTP 服务，resolve 时所有 in-flight 连接已收尾。
   * 调用方可 race 一个超时兜底，避免卡死进程退出。
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server?.close(() => resolve());
    });
  }
}
