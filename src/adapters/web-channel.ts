import { timingSafeEqual } from "node:crypto";
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
import { type Agent, parseAgent, parseAgentInput } from "../domain/agent.js";
import { canManageAgent, canUseAgent } from "../domain/agent-policy.js";
import {
  type Connector,
  ConnectorInputSchema,
  collectCredentialRefs,
} from "../domain/connector.js";
import { substituteCredentialRefs } from "../domain/connector-resolution.js";
import {
  CredentialRenameInputSchema,
  CredentialTemplateInputSchema,
  CredentialValueInputSchema,
  type CredentialValueView,
  parseCredentialCode,
} from "../domain/credential.js";
import { mimeForExt } from "../domain/file-mime.js";
import { type GitProvider, validateGitCredentialBindings } from "../domain/git.js";
import type { LLMConfig } from "../domain/llm-config.js";
import { type Loop, parseLoopInput } from "../domain/loop.js";
import type { UserModelConfig } from "../domain/model-config.js";
import { parseUserModelConfig } from "../domain/model-config.js";
import { validateAgentAgainstPreset } from "../domain/scenario-preset.js";
import { parseTriggerInput, type Trigger } from "../domain/trigger.js";
import {
  type ApprovalCard,
  type IncomingMessage,
  type MessageFile,
  MessageFileSchema,
  type OutgoingMessage,
} from "../domain/types.js";
import { checkUnattendedSafety } from "../domain/unattended-guard.js";
import type { User } from "../domain/user.js";
import { parseWorkflowInput, type Workflow } from "../domain/workflow.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { ActivitySnapshot } from "../orchestrator/activity-tracker.js";
import { AGENT_BUILDER_AGENT, AGENT_BUILDER_ID } from "../orchestrator/agent-builder.js";
import { BUILTIN_ASSIST_AGENT, BUILTIN_ASSIST_AGENT_ID } from "../orchestrator/assist-agent.js";
import type { GitAccessCheck, GitAccessGate } from "../orchestrator/git-access-gate.js";
import type { HookRegistry } from "../orchestrator/hook-registry.js";
import type { LoopRunner } from "../orchestrator/loop-runner.js";
import { buildOptimizeBrief } from "../orchestrator/optimize-brief.js";
import type { SchedulerService } from "../orchestrator/scheduler.js";
import type { AgentShareStore } from "../ports/agent-share-store.js";
import type { AgentStore } from "../ports/agent-store.js";
import type { AuditStore } from "../ports/audit-store.js";
import type {
  Channel,
  MissingCredentialItem,
  MissingCredentialsDecision,
  MissingCredentialsRequest,
} from "../ports/channel.js";
import type { CommentStore } from "../ports/comment-store.js";
import type { ConnectorStore } from "../ports/connector-store.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type { FileBrowser } from "../ports/file-browser.js";
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
  handleInstall,
  handleInstallUpload,
  handleListPacks,
  handleSetPackEnabled,
  handleSetSkillEnabled,
  handleUninstall,
  handleUpdate,
  type SkillApiDeps,
} from "./skill-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** get-or-create 复用匹配：同一 agent 已有多个会话时取最近使用的（updatedAt 倒序首个），而非创建序首个 */
function latestConversationFor<T extends { agentId: string; updatedAt: string }>(
  list: T[],
  agentId: string,
): T | undefined {
  return list
    .filter((c) => c.agentId === agentId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/** JSON-RPC over HTTP 响应解析：application/json 直取；text/event-stream 从 data: 行找匹配 id 的信封 */
export function extractRpcResult(body: string, id: number): Record<string, unknown> | undefined {
  const candidates: unknown[] = [];
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    try {
      candidates.push(JSON.parse(trimmed) as unknown);
    } catch {
      // fallthrough 到 SSE data: 行解析
    }
  }
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*data:\s*(.+)$/);
    if (!m?.[1]) continue;
    try {
      candidates.push(JSON.parse(m[1]) as unknown);
    } catch {
      // 跳过非 JSON 行
    }
  }
  for (const c of candidates) {
    if (c && typeof c === "object" && (c as { id?: unknown }).id === id) {
      return c as Record<string, unknown>;
    }
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export type StaticTarget = { kind: "file"; absPath: string } | null;

/**
 * 决定静态文件如何托管（纯函数，便于单测）。
 * 仅当 web/dist 存在时托管：dist 内真实文件（public 图标、hash 资产等）直返；
 * 其余未知路径 → dist/index.html（SPA fallback）；无 dist → null。
 */
export function resolveStaticFile(webRoot: string, urlPath: string): StaticTarget {
  const distRoot = join(webRoot, "dist");
  if (!existsSync(distRoot)) return null;

  if (urlPath === "/" || urlPath === "/index.html") {
    return { kind: "file", absPath: join(distRoot, "index.html") };
  }
  // hash 资产缺失保持 404（暴露构建脱节），不走 SPA fallback
  if (urlPath.startsWith("/assets/")) {
    const file = resolveRealFile(distRoot, urlPath);
    return file ? { kind: "file", absPath: file } : null;
  }
  const file = resolveRealFile(distRoot, urlPath);
  if (file) return { kind: "file", absPath: file };
  return { kind: "file", absPath: join(distRoot, "index.html") };
}

/** 解析 dist 内真实文件；防路径穿越（必须仍落在 dist 内），不存在返回 null */
function resolveRealFile(distRoot: string, urlPath: string): string | null {
  // join 会把开头的 "/" 当普通段拼接（resolve 则会当绝对路径跳出 dist）
  const resolved = resolve(join(distRoot, urlPath));
  return resolved.startsWith(distRoot + sep) && existsSync(resolved) ? resolved : null;
}

function contentType(absPath: string): string {
  if (absPath.endsWith(".html")) return "text/html; charset=utf-8";
  if (absPath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (absPath.endsWith(".css")) return "text/css; charset=utf-8";
  if (absPath.endsWith(".svg")) return "image/svg+xml";
  if (absPath.endsWith(".png")) return "image/png";
  if (absPath.endsWith(".ico")) return "image/x-icon";
  if (absPath.endsWith(".webmanifest")) return "application/manifest+json";
  if (absPath.endsWith(".json")) return "application/json; charset=utf-8";
  if (absPath.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

/** SSE 事件类型 */
type SSEEvent =
  | { type: "text"; text: string }
  | { type: "text_delta"; messageId: string; text: string }
  | { type: "thinking_delta"; messageId: string; text: string }
  | { type: "activity"; text: string }
  | { type: "approval_card"; gateId: string; title: string; summary: string }
  | {
      type: "credential_missing_card";
      reqId: string;
      conversationId: string;
      items: MissingCredentialItem[];
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
  commentStore?: CommentStore;
  sessionStore?: SessionStore;
  /** CLI 前端登录共享密钥（非空时启用 POST /api/auth/exchange） */
  cliToken?: string;
  fileBrowser?: FileBrowser;
  skillPackStore?: SkillPackStore;
  installer?: SkillInstaller;
  credentialSets?: CredentialSetStore;
  /** 连接器（HTTP MCP 注册表）；缺省=端点不可用 */
  connectorStore?: ConnectorStore;
  modelConfigStore?: UserModelConfigStore;
  agentStore?: AgentStore;
  agentShareStore?: AgentShareStore;
  gitAccessGate?: GitAccessGate;
  /** 工作流模块（M14+M15+M6）—— 缺省=不支持 */
  triggerStore?: TriggerStore;
  workflowStore?: WorkflowStore;
  loopStore?: LoopStore;
  loopRunner?: LoopRunner;
  scheduler?: SchedulerService;
  hookRegistry?: HookRegistry;
  /** 会话实时执行状态查询（SDK 事件流推导，Observability 用）；缺省=端点 503 */
  activityGetter?: (conversationId: string) => ActivitySnapshot | undefined;
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
  private readonly webRoot: string;
  private readonly workspaceDir: string;
  private readonly messageStore?: MessageStore;
  private readonly sessionStore?: SessionStore;
  private readonly fileBrowser?: FileBrowser;
  private readonly agentStore?: AgentStore;
  private readonly agentShareStore?: AgentShareStore;
  private readonly connectorStore?: ConnectorStore;
  private readonly agentMeta?: { presets: LlmPreset[]; skillPaths: string[] };
  private readonly dingtalkConfig?: { appKey: string; appSecret: string };
  private readonly oauthStateMap = new Map<string, number>();

  constructor(private readonly deps: WebChannelDeps) {
    this.webRoot = deps.webRoot ?? join(__dirname, "..", "..", "web");
    this.workspaceDir = deps.workspaceDir;
    this.messageStore = deps.messageStore;
    this.sessionStore = deps.sessionStore;
    this.fileBrowser = deps.fileBrowser;
    this.agentStore = deps.agentStore;
    this.agentShareStore = deps.agentShareStore;
    this.connectorStore = deps.connectorStore;
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
  /** 中间过程行（工具调用等）：广播 activity 事件，不落库 */
  pushActivity(conversationId: string, text: string): void {
    this.broadcastToConversation(conversationId, { type: "activity", text });
  }

  pushTextDelta(conversationId: string, messageId: string, text: string): void {
    this.broadcastToConversation(conversationId, { type: "text_delta", messageId, text });
  }

  pushThinkingDelta(conversationId: string, messageId: string, text: string): void {
    this.broadcastToConversation(conversationId, { type: "thinking_delta", messageId, text });
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
    // V21 修复：先把审批卡广播给会话订阅者（此前卡片从不推送，前端/CLI 全程看不到门）
    this.broadcastToConversation(threadId, {
      type: "approval_card",
      gateId: card.gateId,
      title: card.title,
      summary: card.summary,
    });
    return new Promise((resolve, reject) => {
      this.approvalStreams.set(card.gateId, {
        write: (_event: SSEEvent) => {},
        close: () => {},
      });

      // 超时分型（PM 评审）：生命周期门（方案/验收）是人工评审动作，放宽到 10 分钟；
      // 工具高危门保持 60 秒（安全语义：执行前的确认应即时）。
      const lifeCycleGate = card.gateId === "design" || card.gateId === "acceptance";
      const timeoutMs = lifeCycleGate ? 600_000 : 60_000;
      const timeout = setTimeout(() => {
        this.approvalStreams.delete(card.gateId);
        reject(new Error(`审批超时（${lifeCycleGate ? "10分钟" : "60秒"}）：${card.title}`));
      }, timeoutMs);

      // 注意：实际的审批响应通过 HTTP POST /api/approvals/:id/respond 处理
      // 这里返回一个占位 Promise，实际响应由 HTTP 处理器调用 resolve
      this.pendingApprovalResolves.set(card.gateId, {
        conversationId: threadId,
        resolve: (result) => {
          clearTimeout(timeout);
          this.approvalStreams.delete(card.gateId);
          resolve(result);
        },
      });
    });
  }

  /** 存储审批响应的 resolve 函数（带会话归属，供 owner 校验） */
  private readonly pendingApprovalResolves = new Map<
    string,
    {
      conversationId: string;
      resolve: (result: {
        approved: boolean;
        reason?: string;
        comment?: string;
        responderId?: string;
      }) => void;
    }
  >();

  /** 凭证缺失问询决议（key = reqId；带会话归属供 owner 校验） */
  private readonly pendingMissingDecides = new Map<
    string,
    { conversationId: string; resolve: (decision: MissingCredentialsDecision) => void }
  >();

  /** 凭证缺失问询（SSE credential_missing_card + HTTP POST /api/credential-missing/:reqId/decide）。 */
  async requestMissingCredentials(
    threadId: string,
    req: MissingCredentialsRequest,
  ): Promise<MissingCredentialsDecision> {
    void threadId;
    const reqId = crypto.randomUUID();
    this.broadcastToConversation(req.conversationId, {
      type: "credential_missing_card",
      reqId,
      conversationId: req.conversationId,
      items: req.items,
    });
    return new Promise((resolve) => {
      // 30 分钟无决议 → 按暂停收敛（任务留在 awaiting_credentials 挂起态，不失败）
      const timeout = setTimeout(() => {
        this.pendingMissingDecides.delete(reqId);
        resolve("pause");
      }, 1_800_000);
      this.pendingMissingDecides.set(reqId, {
        conversationId: req.conversationId,
        resolve: (decision) => {
          clearTimeout(timeout);
          this.pendingMissingDecides.delete(reqId);
          resolve(decision);
        },
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

  async send(threadId: string, msg: OutgoingMessage): Promise<void> {
    // SSE 模式下 threadId 即 conversationId：广播给该会话的 SSE 客户端并持久化，
    // 否则 busy/并发上限/分发 none 等系统通知在 Web 端会静默丢失。
    await this.deps.messageStore
      ?.add(threadId, "bot", msg.text)
      .catch((err) => console.error("[web-channel] send 持久化失败", err));
    this.broadcastToConversation(threadId, { type: "text", text: msg.text });
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
      // 审批/凭证/消息/取消：任何异常都以 500 响应，绝不逃逸打崩进程
      try {
        // 审批响应
        if (
          url.startsWith("/api/approvals/") &&
          req.method === "POST" &&
          url.endsWith("/respond")
        ) {
          await this.handleApprovalRespond(req, res);
          return;
        }
        // 凭证缺失问询决议
        if (
          url.startsWith("/api/credential-missing/") &&
          req.method === "POST" &&
          url.endsWith("/decide")
        ) {
          await this.handleMissingCredentialDecide(url, req, res);
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
      } catch (e) {
        console.error("[web] 消息类路由异常:", e);
        if (!res.headersSent) {
          this.json(res, { error: e instanceof Error ? e.message : "internal error" }, 500);
        }
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
    const conversationId = match[1] ?? "";

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
    const approvalId = match[1] ?? "";

    // 认证：审批决议是高危操作，未装配 sessionStore（本地无认证模式）时跳过
    let authUserId: string | undefined;
    if (this.sessionStore) {
      authUserId = (await this.authMiddleware(req)) ?? undefined;
      if (!authUserId) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    const body = JSON.parse(await this.readBody(req)) as {
      approved: boolean;
      reason?: string;
      comment?: string;
    };

    const pending = this.pendingApprovalResolves.get(approvalId);
    if (pending) {
      // 会话属主校验（多用户隔离）：仅会话 owner 可决议
      const conv = await this.deps.conversationStore?.get(pending.conversationId);
      if (conv && authUserId && conv.userId !== authUserId) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "forbidden: 仅会话属主可审批" }));
        return;
      }
      this.pendingApprovalResolves.delete(approvalId);
      // 审批可带评论（T17.3）：resolver 侧按 taskId 落 task_comments
      pending.resolve({
        approved: body.approved,
        reason: body.reason,
        comment: body.comment?.trim() || undefined,
        responderId: authUserId,
      });
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "approval not found or expired" }));
    }
  }

  /** 凭证缺失问询决议：按 reqId 解析 pendingMissingDecides，把决议回传给 requestMissingCredentials */
  private async handleMissingCredentialDecide(
    url: string,
    req: HttpRequest,
    res: ServerResponse,
  ): Promise<void> {
    const match = url.match(/^\/api\/credential-missing\/([\w-]+)\/decide$/);
    if (!match) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid credential-missing url" }));
      return;
    }
    const reqId = match[1] ?? "";

    // 认证 + 会话属主校验：决议只能由会话 owner 作出
    let authUserId: string | undefined;
    if (this.sessionStore) {
      authUserId = (await this.authMiddleware(req)) ?? undefined;
      if (!authUserId) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    const body = JSON.parse(await this.readBody(req)) as { decision?: string };
    const decision = body.decision as MissingCredentialsDecision | undefined;
    if (
      decision !== "continue" &&
      decision !== "pause" &&
      decision !== "retry" &&
      decision !== "cancel"
    ) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "decision 必须是 continue/pause/retry/cancel" }));
      return;
    }
    const pending = this.pendingMissingDecides.get(reqId);
    if (pending) {
      const conv = await this.deps.conversationStore?.get(pending.conversationId);
      if (conv && authUserId && conv.userId !== authUserId) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "forbidden: 仅会话属主可决议" }));
        return;
      }
      pending.resolve(decision);
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
    const conversationId = match[1] ?? "";

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
      "/api/auth/exchange",
      "/api/agents/by-share",
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

    const preflightMatch = url.match(/^\/api\/conversations\/([\w-]+)\/preflight$/);
    if (preflightMatch && req.method === "GET") {
      const result = await this.checkConversationGitAccess(
        this.requireRequestUser(req),
        preflightMatch[1] ?? "",
      );
      this.json(res, result ?? { ready: true, requirements: [] });
      return;
    }

    // === Auth 路由 ===

    // POST /api/auth/exchange —— CLI 共享密钥换 JWT（CLI_TOKEN 未配置时端点关闭）
    if (url === "/api/auth/exchange" && req.method === "POST") {
      if (!this.deps.cliToken || !this.deps.userStore || !this.sessionStore) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "CLI_TOKEN 未配置，交换端点未启用" }));
        return;
      }
      const body = JSON.parse(await this.readBody(req)) as { token?: string };
      const provided = Buffer.from(body.token ?? "");
      const expected = Buffer.from(this.deps.cliToken);
      // 恒定时间比较，避免时序侧信道
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "token 无效" }));
        return;
      }
      const user = await this.deps.userStore.getOrCreateByIdentity(
        "internal",
        "cli-admin",
        "cli-admin",
      );
      const { token } = await this.sessionStore.create(user.id);
      this.json(res, { token, user });
      return;
    }

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
      const auth = req.headers.authorization;
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

    // GET /api/tasks（兼容 ?status= 查询串）
    if (url.split("?")[0] === "/api/tasks" && req.method === "GET") {
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

    // GET /api/tasks/:id/events —— 该任务全量审计事件（T17.3 观测数据源）
    const taskEventsMatch = url.match(/^\/api\/tasks\/([\w-]+)\/events$/);
    if (taskEventsMatch && req.method === "GET") {
      const events = (await this.deps.auditStore?.listByTask(taskEventsMatch[1] ?? "")) ?? [];
      res.writeHead(200);
      res.end(JSON.stringify(events));
      return;
    }

    // GET/POST /api/tasks/:id/comments —— 任务评论（T17.3 观测/反馈闭环）
    const taskCommentsMatch = url.match(/^\/api\/tasks\/([\w-]+)\/comments$/);
    if (taskCommentsMatch) {
      const taskId = taskCommentsMatch[1] ?? "";
      if (req.method === "GET") {
        const comments = (await this.deps.commentStore?.listByTask(taskId)) ?? [];
        res.writeHead(200);
        res.end(JSON.stringify(comments));
        return;
      }
      if (req.method === "POST") {
        if (!this.deps.commentStore) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: "评论服务未启用" }));
          return;
        }
        const uid = this.requireRequestUser(req);
        const body = JSON.parse(await this.readBody(req)) as { text?: string };
        const text = body.text?.trim();
        if (!text) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "text 为必填" }));
          return;
        }
        const comment = await this.deps.commentStore.add(taskId, uid, text);
        res.writeHead(201);
        res.end(JSON.stringify(comment));
        return;
      }
    }

    // POST /api/tasks/:id/optimize —— 触发 task-optimize（T17.4 反馈闭环）
    // 聚合该任务审计事件+评论为材料，投递到调用者的内置 assist 会话（写盘经 authoring 审批卡确认）。
    const taskOptimizeMatch = url.match(/^\/api\/tasks\/([\w-]+)\/optimize$/);
    if (taskOptimizeMatch && req.method === "POST") {
      const taskId = taskOptimizeMatch[1] ?? "";
      const uid = this.requireRequestUser(req);
      const task = await this.deps.taskStore?.get(taskId);
      if (!task) return this.json(res, { error: "task not found" }, 404);
      if (task.requesterId !== uid) return this.json(res, { error: "forbidden" }, 403);
      if (!this.handler) return this.json(res, { error: "消息处理未就绪" }, 503);

      const events = (await this.deps.auditStore?.listByTask(taskId)) ?? [];
      const comments = (await this.deps.commentStore?.listByTask(taskId)) ?? [];
      const agent = task.agentId
        ? ((await this.agentStore?.get(task.agentId)) ?? undefined)
        : undefined;
      const skillsDir = agent ? join(this.deps.workspaceDir, "users", uid, "skills") : undefined;
      const kbDir = agent ? join(this.deps.workspaceDir, "kb", agent.id) : undefined;
      const brief = buildOptimizeBrief({
        task,
        events,
        comments,
        agent,
        agentSkillsDir: agent ? skillsDir : undefined,
        agentKbDir: agent ? kbDir : undefined,
      });

      // builtin-assist 会话 get-or-create（与 agentConvMatch 的内置分支一致）
      const list = (await this.deps.conversationStore?.listByUser(uid)) ?? [];
      let conv = list.find((c) => c.agentId === BUILTIN_ASSIST_AGENT_ID);
      if (!conv) {
        conv = await this.deps.conversationStore?.createWithAgent(
          uid,
          "web",
          BUILTIN_ASSIST_AGENT.name,
          BUILTIN_ASSIST_AGENT_ID,
        );
      }
      if (!conv) return this.json(res, { error: "会话存储不可用" }, 500);

      // 用户消息落库 + 投递 orchestrator（builtin 短路，不走 git/附件检查）
      await this.deps.messageStore
        ?.add(conv.id, "user", brief)
        .catch((e) => console.error("[optimize] 保存消息失败", e));
      this.handler({
        channelId: "web",
        threadId: conv.id,
        requesterId: uid,
        text: brief,
        conversationId: conv.id,
      });
      return this.json(res, { conversationId: conv.id }, 201);
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

    // GET /api/conversations/:id/activity — 会话实时执行状态（SDK 事件流推导；owner/admin 可见）
    const activityMatch = url.match(/^\/api\/conversations\/([\w-]+)\/activity$/);
    if (activityMatch && req.method === "GET") {
      if (!this.deps.activityGetter) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "activity 服务未启用" }));
        return;
      }
      const conversationId = activityMatch[1] ?? "";
      const uid = this.requireRequestUser(req);
      const conv = await this.deps.conversationStore?.get(conversationId);
      const viewer = uid ? await this.deps.userStore?.get(uid) : undefined;
      if (conv && viewer && conv.userId !== viewer.id && viewer.role !== "admin") {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "forbidden: 仅会话属主或管理员可查看执行状态" }));
        return;
      }
      const activity = this.deps.activityGetter(conversationId);
      res.writeHead(activity ? 200 : 204);
      res.end(activity ? JSON.stringify({ activity }) : "");
      return;
    }

    // GET /api/conversations/:id/messages — 会话消息列表
    // GET /api/conversations/:id/events —— 会话执行事件回放（audit 统一事件源；owner/admin 可见）
    const eventsMatch = url.match(/^\/api\/conversations\/([\w-]+)\/events$/);
    if (eventsMatch && req.method === "GET") {
      const conversationId = eventsMatch[1] ?? "";
      const uid = this.requireRequestUser(req);
      const conv = await this.deps.conversationStore?.get(conversationId);
      const viewer = uid ? await this.deps.userStore?.get(uid) : undefined;
      if (conv && viewer && conv.userId !== viewer.id && viewer.role !== "admin") {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "forbidden: 仅会话属主或管理员可查看执行事件" }));
        return;
      }
      const all = (await this.deps.auditStore?.listByConversation(conversationId)) ?? [];
      // llm_input/llm_output 是调试级原始消息（体积大、含系统提示），不入回放流
      const events = all.filter((e) => e.type !== "llm_input" && e.type !== "llm_output");
      this.json(res, { events });
      return;
    }

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
      const deduped = out.filter((a) => {
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        return true;
      });
      return this.json(res, deduped);
    }
    if (url === "/api/agents" && req.method === "POST") {
      const me = this.requireUserId(req);
      const body = JSON.parse(await this.readBody(req));
      const input = parseAgentInput({ ...body, ownerId: me });
      const bindingError = await this.validateGitBindings(input.gitRepositories ?? []);
      if (bindingError) return this.json(res, { error: bindingError }, 400);
      const connectorError = await this.validateAgentConnectorRefs(me, input);
      if (connectorError) return this.json(res, { error: connectorError }, 400);
      const created = await this.agentStore?.create(input);
      if (!created) return this.json(res, { error: "agent store unavailable" }, 500);
      return this.json(
        res,
        {
          ...this.agentToDTO(created, true),
          warnings: await this.agentEquipmentWarnings(me, created),
        },
        201,
      );
    }
    if (url === "/api/agents/meta/options" && req.method === "GET") {
      const userId = this.requireUserId(req);
      return this.json(res, {
        skills: await this.discoverAgentSkills(userId),
        tools: BUILTIN_TOOLS,
        llmPresets: this.agentMeta?.presets ?? [],
      });
    }
    // GET /api/agents/:id/versions —— 版本历史（摘要，不含 mcp 密钥字段）
    const agentVersionsMatch = url.match(/^\/api\/agents\/([\w-]+)\/versions$/);
    if (agentVersionsMatch && req.method === "GET") {
      const id = agentVersionsMatch[1] ?? "";
      const me = this.requireUserId(req);
      const a = await this.agentStore?.get(id);
      if (!a) return this.json(res, { error: "not found" }, 404);
      const meUser = await this.deps.userStore?.get(me);
      const actor = { id: me, role: (meUser?.role ?? "user") as "admin" | "user" };
      const granted = this.agentShareStore ? await this.agentShareStore.isGranted(id, me) : false;
      if (!canUseAgent(a, actor, granted)) return this.json(res, { error: "forbidden" }, 403);
      return this.json(res, { versions: (await this.agentStore?.listVersions(id)) ?? [] });
    }
    // POST /api/agents/:id/versions/:version/rollback —— 回滚（生成新版本，不改写历史）
    const agentRollbackMatch = url.match(/^\/api\/agents\/([\w-]+)\/versions\/(\d+)\/rollback$/);
    if (agentRollbackMatch && req.method === "POST") {
      const id = agentRollbackMatch[1] ?? "";
      const target = Number(agentRollbackMatch[2]);
      const me = this.requireUserId(req);
      const a = await this.agentStore?.get(id);
      if (!a) return this.json(res, { error: "not found" }, 404);
      const meUser = await this.deps.userStore?.get(me);
      const actor = { id: me, role: (meUser?.role ?? "user") as "admin" | "user" };
      if (!canManageAgent(a, actor)) return this.json(res, { error: "forbidden" }, 403);
      try {
        const rolled = await this.agentStore?.rollback(id, target);
        return this.json(res, this.agentToDTO(rolled ?? a, true));
      } catch {
        return this.json(res, { error: `version not found: ${target}` }, 404);
      }
    }
    const agentMatch = url.match(/^\/api\/agents\/([\w-]+)$/);
    if (
      agentMatch &&
      !url.includes("/share/") &&
      !url.includes("/conversation") &&
      !url.includes("/accept-share") &&
      !url.includes("/by-share")
    ) {
      const id = agentMatch[1] ?? "";
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
        const merged = { ...a, ...this.mergeMaskedMcp(a, patch) };
        // 合并结果必须过 AgentSchema（ZodError → 400）：PATCH 是唯一不走 parseAgentInput 的写入口，
        // 不校验会让非法数据（如空仓库名）落库，毒化读路径使整个 agent 列表 500
        const validated = parseAgent(merged);
        const bindingError = await this.validateGitBindings(validated.gitRepositories);
        if (bindingError) return this.json(res, { error: bindingError }, 400);
        const connectorError = await this.validateAgentConnectorRefs(me, validated);
        if (connectorError) return this.json(res, { error: connectorError }, 400);
        const updated = await this.agentStore?.update(id, validated);
        if (!updated) return this.json(res, { error: "agent store unavailable" }, 500);
        return this.json(res, {
          ...this.agentToDTO(updated, true),
          warnings: await this.agentEquipmentWarnings(me, updated),
        });
      }
      if (req.method === "DELETE") {
        if (!canManageAgent(a, actor)) return this.json(res, { error: "forbidden" }, 403);
        // 被 workflow 引用时拒绝删除，避免运行时悬空引用（与触发器删除防护同款）
        const wfCount = (await this.deps.workflowStore?.countByAgentId(id)) ?? 0;
        if (wfCount > 0) {
          return this.json(res, { error: `被 ${wfCount} 个工作流引用，无法删除` }, 409);
        }
        await this.agentStore?.delete(id);
        res.writeHead(204);
        res.end();
        return;
      }
    }
    const agentConvMatch = url.match(/^\/api\/agents\/([\w-]+)\/conversation$/);
    if (agentConvMatch && req.method === "GET") {
      const id = agentConvMatch[1] ?? "";
      const me = this.requireUserId(req);
      // 内置智能体（assist/builder）：代码常量不入库，直接 get-or-create 其会话
      const builtinName =
        id === BUILTIN_ASSIST_AGENT_ID
          ? BUILTIN_ASSIST_AGENT.name
          : id === AGENT_BUILDER_ID
            ? AGENT_BUILDER_AGENT.name
            : undefined;
      if (builtinName) {
        const list = (await this.deps.conversationStore?.listByUser(me)) ?? [];
        const existing = latestConversationFor(list, id);
        const conv =
          existing ??
          (await this.deps.conversationStore?.createWithAgent(me, "cli", builtinName, id));
        return this.json(res, conv);
      }
      const a = await this.agentStore?.get(id);
      if (!a) return this.json(res, { error: "not found" }, 404);
      const meUser = await this.deps.userStore?.get(me);
      const actor = { id: me, role: (meUser?.role ?? "user") as "admin" | "user" };
      const granted = this.agentShareStore ? await this.agentShareStore.isGranted(id, me) : false;
      if (!canUseAgent(a, actor, granted)) return this.json(res, { error: "forbidden" }, 403);
      const list = (await this.deps.conversationStore?.listByUser(me)) ?? [];
      const existing = latestConversationFor(list, id);
      const conv =
        existing ?? (await this.deps.conversationStore?.createWithAgent(me, "web", a.name, id));
      return this.json(res, conv);
    }

    // === 分享路由 ===
    const shareMatch = url.match(/^\/api\/agents\/([\w-]+)\/share$/);
    if (shareMatch) {
      const sid = shareMatch[1] ?? "";
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
          const s = await this.agentShareStore?.enableShare(sid);
          if (!s) return this.json(res, { error: "share store unavailable" }, 500);
          return this.json(res, { enabled: true, token: s.token, url: `/share/${s.token}` });
        }
        await this.agentShareStore?.disableShare(sid);
        return this.json(res, { enabled: false, token: null, url: null });
      }
    }
    const removeGrantMatch = url.match(/^\/api\/agents\/([\w-]+)\/share\/grants\/([\w-]+)$/);
    if (removeGrantMatch && req.method === "DELETE") {
      const sid = removeGrantMatch[1] ?? "";
      const grantUserId = removeGrantMatch[2] ?? "";
      const me = this.requireUserId(req);
      const a = await this.agentStore?.get(sid);
      if (!a) return this.json(res, { error: "not found" }, 404);
      const meUser = await this.deps.userStore?.get(me);
      const actor = { id: me, role: (meUser?.role ?? "user") as "admin" | "user" };
      if (!canManageAgent(a, actor)) return this.json(res, { error: "forbidden" }, 403);
      await this.agentShareStore?.removeGrant(sid, grantUserId);
      return this.json(res, { ok: true });
    }
    // 公开：by-share（不泄配置）
    const byShareMatch = url.match(/^\/api\/agents\/by-share\/([\w-]+)$/);
    if (byShareMatch && req.method === "GET") {
      const ref = await this.agentShareStore?.findByToken(byShareMatch[1] ?? "");
      if (!ref?.enabled) return this.json(res, { error: "not found" }, 404);
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
      const sid = acceptMatch[1] ?? "";
      const me = this.requireUserId(req);
      const { token } = JSON.parse(await this.readBody(req)) as { token: string };
      const ref = await this.agentShareStore?.findByToken(token);
      if (!ref?.enabled || ref.agentId !== sid) {
        return this.json(res, { error: "invalid token" }, 403);
      }
      await this.agentShareStore?.addGrant(sid, me);
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

    if (await this.handleConnectorApi(url, req, res)) return;

    res.writeHead(404);
    res.end(JSON.stringify({ error: "unknown endpoint" }));
  }

  /** 工作流模块资源所有权校验：不存在或不属于该用户均抛 NotFoundError（避免存在性泄露）。 */
  private async requireOwnedTrigger(id: string, uid: string): Promise<Trigger> {
    const t = await this.deps.triggerStore?.get(id);
    if (!t?.ownerId || t.ownerId !== uid) {
      throw new NotFoundError("NOT_FOUND", "trigger 不存在");
    }
    return t;
  }

  private async requireOwnedWorkflow(id: string, uid: string): Promise<Workflow> {
    const w = await this.deps.workflowStore?.get(id);
    if (!w?.ownerId || w.ownerId !== uid) {
      throw new NotFoundError("NOT_FOUND", "workflow 不存在");
    }
    return w;
  }

  private async requireOwnedLoop(id: string, uid: string): Promise<Loop> {
    const l = await this.deps.loopStore?.get(id);
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

  // ---------------------------------------------------------------------------
  // 连接器（HTTP MCP 注册表）
  // ---------------------------------------------------------------------------

  private async handleConnectorApi(
    url: string,
    req: HttpRequest,
    res: ServerResponse,
  ): Promise<boolean> {
    const cstore = this.connectorStore;
    if (!cstore) return false;
    const basePath = url.split("?")[0] ?? url;
    const uid = this.requireRequestUser(req);
    const send = (r: { status: number; json: unknown }) => {
      res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r.json));
    };
    const bad = (msg: string) => send({ status: 400, json: { error: msg } });

    // POST /api/connectors/test —— 未保存也可测（body 即表单）；用发起者的凭证解析 {{credential:*}}
    if (basePath === "/api/connectors/test" && req.method === "POST") {
      const b = JSON.parse(await this.readBody(req)) as Record<string, unknown>;
      const parsed = ConnectorInputSchema.pick({ url: true, headers: true }).safeParse(b);
      if (!parsed.success) {
        bad(parsed.error.issues[0]?.message ?? "参数非法");
        return true;
      }
      const { resolved, missing } = await this.resolveConnectorHeaders(
        uid,
        parsed.data.headers ?? {},
      );
      if (missing.length > 0) {
        send({ status: 200, json: { ok: false, error: `凭证未配置: ${missing.join(", ")}` } });
        return true;
      }
      send({ status: 200, json: await this.probeMcpHttp(parsed.data.url, resolved) });
      return true;
    }

    if (basePath === "/api/connectors" && req.method === "GET") {
      const [list, refMap] = await Promise.all([cstore.listForUser(uid), this.connectorRefs()]);
      send({
        status: 200,
        json: {
          connectors: list.map((c) => this.connectorToDTO(c, uid, refMap.get(c.id)?.length ?? 0)),
        },
      });
      return true;
    }

    if (basePath === "/api/connectors" && req.method === "POST") {
      const b = JSON.parse(await this.readBody(req)) as Record<string, unknown>;
      const parsed = ConnectorInputSchema.safeParse(b);
      if (!parsed.success) {
        bad(parsed.error.issues[0]?.message ?? "参数非法");
        return true;
      }
      if (await cstore.getByOwnerAndName(uid, parsed.data.name)) {
        send({ status: 409, json: { error: `连接器名称已存在: ${parsed.data.name}` } });
        return true;
      }
      const created = await cstore.create(parsed.data, uid);
      send({ status: 201, json: this.connectorToDTO(created, uid, 0) });
      return true;
    }

    const m = basePath.match(/^\/api\/connectors\/([\w-]+)$/);
    if (!m) return false;
    const c = await cstore.getById(m[1] ?? "");
    if (!c) {
      send({ status: 404, json: { error: "连接器不存在" } });
      return true;
    }
    const isOwner = c.ownerId === uid;

    if (req.method === "GET") {
      if (!isOwner && c.shareScope !== "global") {
        send({ status: 403, json: { error: "forbidden: 私有连接器仅创建人可见" } });
        return true;
      }
      const refMap = await this.connectorRefs();
      send({ status: 200, json: this.connectorToDTO(c, uid, refMap.get(c.id)?.length ?? 0) });
      return true;
    }

    // 写操作仅创建人（裁决②：global 人人可用，管理权仍归创建人）
    if (!isOwner) {
      send({ status: 403, json: { error: "forbidden: 仅创建人可管理" } });
      return true;
    }

    if (req.method === "DELETE") {
      const refs = (await this.connectorRefs()).get(c.id) ?? [];
      if (refs.length > 0) {
        send({
          status: 409,
          json: {
            error: `已被 ${refs.length} 个智能体引用，先解除引用后再删除`,
            agents: refs.map((a) => ({ id: a.id, name: a.name })),
          },
        });
        return true;
      }
      await cstore.delete(c.id);
      send({ status: 200, json: { ok: true } });
      return true;
    }

    if (req.method === "PATCH" || req.method === "PUT") {
      const b = JSON.parse(await this.readBody(req)) as Record<string, unknown>;
      const parsed = ConnectorInputSchema.safeParse(b);
      if (!parsed.success) {
        bad(parsed.error.issues[0]?.message ?? "参数非法");
        return true;
      }
      const input = {
        ...parsed.data,
        headers: this.mergeMaskedHeaders(c.headers, parsed.data.headers ?? {}),
      };
      if (input.name !== c.name) {
        const taken = await cstore.getByOwnerAndName(c.ownerId, input.name);
        if (taken && taken.id !== c.id) {
          send({ status: 409, json: { error: `连接器名称已存在: ${input.name}` } });
          return true;
        }
        // 改名反向校验：不得让已引用 agent 产生 MCP 重名（spec §3.4）
        const conflicts = await this.connectorRenameConflicts(c, input.name);
        if (conflicts.length > 0) {
          send({
            status: 409,
            json: {
              error: `改名将与引用它的智能体产生 MCP 重名: ${input.name}`,
              agents: conflicts.map((a) => ({ id: a.id, name: a.name })),
            },
          });
          return true;
        }
      }
      const updated = await cstore.update(c.id, input);
      const refMap = await this.connectorRefs();
      send({ status: 200, json: this.connectorToDTO(updated, uid, refMap.get(c.id)?.length ?? 0) });
      return true;
    }

    return false;
  }

  /** connectorId → 引用它的 agent 清单（agents 量级小，全量扫；usedBy/删除保护/改名反校验共用） */
  private async connectorRefs(): Promise<Map<string, Agent[]>> {
    const map = new Map<string, Agent[]>();
    if (!this.agentStore) return map;
    for (const a of await this.agentStore.listAll()) {
      for (const cid of a.connectorIds) {
        const list = map.get(cid) ?? [];
        list.push(a);
        map.set(cid, list);
      }
    }
    return map;
  }

  /** 改名反向校验：新名与引用者的内联 mcpServers 或其引用的其他连接器重名 → 冲突 agent 清单 */
  private async connectorRenameConflicts(
    c: Connector,
    newName: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const cstore = this.connectorStore;
    if (!cstore || newName === c.name) return [];
    const conflicts: Array<{ id: string; name: string }> = [];
    for (const a of (await this.connectorRefs()).get(c.id) ?? []) {
      const inlineNames = new Set(a.mcpServers.map((s) => s.name));
      const otherNames = new Set(
        (await cstore.listByIds(a.connectorIds.filter((x) => x !== c.id))).map((o) => o.name),
      );
      if (inlineNames.has(newName) || otherNames.has(newName)) {
        conflicts.push({ id: a.id, name: a.name });
      }
    }
    return conflicts;
  }

  private connectorToDTO(c: Connector, uid: string, usedBy: number): Record<string, unknown> {
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      transport: c.transport,
      url: c.url,
      // 字面量值掩码；{{credential:*}} 引用本身不含密钥，保持可读以便编辑
      headers: Object.fromEntries(
        Object.entries(c.headers).map(([k, v]) => [k, v.includes("{{credential:") ? v : "••••"]),
      ),
      enabled: c.enabled,
      shareScope: c.shareScope,
      ownerId: c.ownerId,
      createdByMe: c.ownerId === uid,
      usedBy,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  /** 连接器 headers 回传掩码占位（••••）时按 key 用库内原值回填；新增/改动的引用值直通 */
  private mergeMaskedHeaders(
    orig: Record<string, string>,
    next: Record<string, string>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(next)) {
      out[k] = v === "••••" ? (orig[k] ?? v) : v;
    }
    return out;
  }

  /** 按访问者解析 headers 中的 {{credential:*}}（测试端点用；运行时注入在 runtime-manager 同语义复用） */
  private async resolveConnectorHeaders(
    uid: string,
    headers: Record<string, string>,
  ): Promise<{ resolved: Record<string, string>; missing: string[] }> {
    const codes = collectCredentialRefs(headers);
    const valuesByCode = new Map<string, Record<string, string>>();
    const csets = this.deps.credentialSets;
    if (codes.length > 0 && csets) {
      for (const f of await csets.getFilledValues(uid, codes)) valuesByCode.set(f.code, f.values);
    }
    return substituteCredentialRefs(headers, valuesByCode);
  }

  /** MCP streamable HTTP 探活：initialize → notifications/initialized → tools/list（无状态）。错误信息不回显请求头。 */
  private async probeMcpHttp(
    url: string,
    headers: Record<string, string>,
  ): Promise<{
    ok: boolean;
    latencyMs?: number;
    toolCount?: number;
    tools?: string[];
    error?: string;
  }> {
    const started = Date.now();
    const call = (body: unknown, extra: Record<string, string> = {}): Promise<Response> =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
          ...extra,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    try {
      const init = await call({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "donger-connector-test", version: "1.0.0" },
        },
      });
      const initEnv = extractRpcResult(await init.text(), 1);
      if (!init.ok || !initEnv || initEnv.error) {
        return { ok: false, error: truncate(`initialize 失败 (HTTP ${init.status})`, 300) };
      }
      const session = init.headers.get("mcp-session-id");
      const extra: Record<string, string> = session ? { "Mcp-Session-Id": session } : {};
      // initialized 通知失败不阻断探活结果
      await call({ jsonrpc: "2.0", method: "notifications/initialized" }, extra).catch(
        () => undefined,
      );
      const tools = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, extra);
      const toolsEnv = extractRpcResult(await tools.text(), 2);
      if (!tools.ok || !toolsEnv || toolsEnv.error) {
        return { ok: false, error: truncate(`tools/list 失败 (HTTP ${tools.status})`, 300) };
      }
      const names = (
        (toolsEnv.result as { tools?: Array<{ name?: string }> } | undefined)?.tools ?? []
      )
        .map((t) => t.name ?? "")
        .filter(Boolean);
      return { ok: true, latencyMs: Date.now() - started, toolCount: names.length, tools: names };
    } catch (e) {
      return { ok: false, error: truncate(e instanceof Error ? e.message : String(e), 300) };
    }
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
      this.json(res, { triggers: await ts?.listByOwner(uid) });
      return true;
    }
    if (pathname === "/api/triggers" && req.method === "POST") {
      const body = JSON.parse(await this.readBody(req));
      const created = await ts?.create(parseTriggerInput({ ...body, ownerId: uid }));
      this.json(res, created, 201);
      return true;
    }
    let m = pathname.match(/^\/api\/triggers\/([\w-]+)$/);
    if (m && req.method === "GET") {
      this.json(res, await this.requireOwnedTrigger(m[1] ?? "", uid));
      return true;
    }
    if (m && req.method === "PUT") {
      // PUT = 全量替换：parseTriggerInput 要求完整对象（name/type/scheduler|hook 等），缺字段返回 400。
      // store.update 签名虽为 Partial<>，但 HTTP 层强制客户端发全量；如需部分更新请新增 PATCH 路由。
      await this.requireOwnedTrigger(m[1] ?? "", uid);
      const body = JSON.parse(await this.readBody(req));
      const updated = await ts?.update(m[1] ?? "", parseTriggerInput({ ...body, ownerId: uid }));
      // ponytail: trigger cron 可能变更，刷新所有引用此 trigger 的 enabled loops
      await this.deps.scheduler?.refreshByTrigger(m[1] ?? "");
      this.json(res, updated);
      return true;
    }
    if (m && req.method === "DELETE") {
      await this.requireOwnedTrigger(m[1] ?? "", uid);
      const count = (await ts?.countWorkflowsReferencing(m[1] ?? "")) ?? 0;
      if (count > 0) {
        this.json(res, { error: `被 ${count} 个 workflow 引用，无法删除` }, 409);
        return true;
      }
      await ts?.delete(m[1] ?? "");
      this.json(res, { ok: true });
      return true;
    }
    m = pathname.match(/^\/api\/triggers\/([\w-]+)\/test$/);
    if (m && req.method === "POST" && this.deps.loopRunner) {
      await this.requireOwnedTrigger(m[1] ?? "", uid);
      const result = await this.deps.loopRunner.testTrigger(m[1] ?? "");
      this.json(res, result);
      return true;
    }

    // ===== Workflows =====
    if (pathname === "/api/workflows" && req.method === "GET") {
      this.json(res, { workflows: await ws?.listByOwner(uid) });
      return true;
    }
    if (pathname === "/api/workflows" && req.method === "POST") {
      const body = JSON.parse(await this.readBody(req));
      const created = await ws?.create(parseWorkflowInput({ ...body, ownerId: uid }));
      this.json(res, created, 201);
      return true;
    }
    m = pathname.match(/^\/api\/workflows\/([\w-]+)$/);
    if (m && req.method === "GET") {
      this.json(res, await this.requireOwnedWorkflow(m[1] ?? "", uid));
      return true;
    }
    if (m && req.method === "PUT") {
      // PUT = 全量替换：parseWorkflowInput 要求完整对象（name/triggerId/agentId 等）。
      await this.requireOwnedWorkflow(m[1] ?? "", uid);
      const body = JSON.parse(await this.readBody(req));
      const updated = await ws?.update(m[1] ?? "", parseWorkflowInput({ ...body, ownerId: uid }));
      this.json(res, updated);
      return true;
    }
    if (m && req.method === "DELETE") {
      await this.requireOwnedWorkflow(m[1] ?? "", uid);
      await ws?.delete(m[1] ?? "");
      this.json(res, { ok: true });
      return true;
    }

    // ===== Loops =====
    if (pathname === "/api/loops" && req.method === "GET") {
      this.json(res, { loops: await ls?.listByOwner(uid) });
      return true;
    }
    if (pathname === "/api/loops" && req.method === "POST") {
      const body = JSON.parse(await this.readBody(req));
      const created = await ls?.create(parseLoopInput({ ...body, ownerId: uid }));
      this.json(res, created, 201);
      return true;
    }
    m = pathname.match(/^\/api\/loops\/([\w-]+)$/);
    if (m && req.method === "GET") {
      this.json(res, await this.requireOwnedLoop(m[1] ?? "", uid));
      return true;
    }
    if (m && req.method === "PUT") {
      // PUT = 全量替换：parseLoopInput 要求完整对象（name/workflowId 等）。
      await this.requireOwnedLoop(m[1] ?? "", uid);
      const body = JSON.parse(await this.readBody(req));
      const updated = await ls?.update(m[1] ?? "", parseLoopInput({ ...body, ownerId: uid }));
      this.json(res, updated);
      return true;
    }
    if (m && req.method === "DELETE") {
      await this.requireOwnedLoop(m[1] ?? "", uid);
      await ls?.delete(m[1] ?? "");
      this.json(res, { ok: true });
      return true;
    }
    m = pathname.match(/^\/api\/loops\/([\w-]+)\/(enable|disable)$/);
    if (m && req.method === "POST") {
      const loop = await this.requireOwnedLoop(m[1] ?? "", uid);
      const enabled = m[2] === "enable";
      if (enabled) {
        // 无人值守防护：绑定 agent 的技能含验收门时，定时任务会永久卡在人工门 → 拒绝启用
        const wf = loop.workflowId ? await ws?.get(loop.workflowId) : undefined;
        const agent = wf?.agentId ? await this.deps.agentStore?.get(wf.agentId) : undefined;
        if (agent) {
          const check = checkUnattendedSafety(agent);
          if (!check.safe) {
            throw new ValidationError("UNATTENDED_UNSAFE", check.reason);
          }
        }
      }
      const updated = await ls?.setEnabled(m[1] ?? "", enabled);
      // 启停时同步调度器
      if (this.deps.scheduler && updated) {
        if (enabled) await this.deps.scheduler.register(updated);
        else this.deps.scheduler.unregister(updated.id);
      }
      this.json(res, updated);
      return true;
    }
    m = pathname.match(/^\/api\/loops\/([\w-]+)\/run$/);
    if (m && req.method === "POST" && this.deps.loopRunner) {
      // 手动触发：取 workflow 关联的 trigger 一次性测试+fire
      const loop = await this.requireOwnedLoop(m[1] ?? "", uid);
      const wf = loop.workflowId ? await ws?.get(loop.workflowId) : undefined;
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
      await this.requireOwnedLoop(m[1] ?? "", uid);
      const runs = await ls?.listRuns(m[1] ?? "", { limit: 50 });
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
    // 凭证模板查询带 query 参数；剥离 query 供精确匹配路由使用
    const basePath = url.split("?")[0] ?? url;
    const deps = this.skillDeps();
    const uid = (req as HttpRequest & { userId?: string }).userId ?? "";
    const match = (re: RegExp): RegExpMatchArray | null => url.match(re);
    const send = (r: { status: number; json: unknown }) => {
      res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r.json));
    };
    // ---- 凭证模板（全局结构）+ 用户凭证值（本人隔离；值永不回显）----
    const csets = this.deps.credentialSets;
    if (!csets) return false;
    const notFound = (what: string) => {
      send({ status: 404, json: { error: `${what}不存在` } });
      return true;
    };
    if (basePath === "/api/credential-templates" && req.method === "GET") {
      const q = new URL(url, "http://localhost").searchParams.get("q") ?? undefined;
      send({ status: 200, json: { templates: await csets.listTemplates({ q: q || undefined }) } });
      return true;
    }
    if (basePath === "/api/credential-templates" && req.method === "POST") {
      const b = JSON.parse(await this.readBody(req)) as Record<string, unknown>;
      const parsed = CredentialTemplateInputSchema.safeParse(b);
      if (!parsed.success) {
        send({ status: 400, json: { error: parsed.error.issues[0]?.message ?? "参数非法" } });
        return true;
      }
      const code = parseCredentialCode(b.code);
      if (await csets.getTemplate(code)) {
        send({ status: 409, json: { error: `凭证 code 已存在: ${code}` } });
        return true;
      }
      await csets.createTemplate(code, parsed.data, uid);
      send({ status: 201, json: { ok: true, code } });
      return true;
    }
    const tplMatch = match(/^\/api\/credential-templates\/([^/]+)$/);
    if (tplMatch && (req.method === "PUT" || req.method === "DELETE")) {
      const code = decodeURIComponent(tplMatch[1] ?? "");
      const tpl = await csets.getTemplate(code);
      if (!tpl) return notFound(`凭证模板 ${code} `);
      if (tpl.createdBy !== uid) {
        send({ status: 403, json: { error: "forbidden: 仅模板创建人可管理" } });
        return true;
      }
      if (req.method === "DELETE") {
        const refs = await csets.countTemplateReferences(code);
        if (refs > 0) {
          send({
            status: 409,
            json: { error: `已被 ${refs} 个用户配置，先删除对应用户凭证后再删除模板` },
          });
          return true;
        }
        await csets.deleteTemplate(code);
        send({ status: 200, json: { ok: true } });
        return true;
      }
      const b = JSON.parse(await this.readBody(req)) as Record<string, unknown>;
      const parsed = CredentialTemplateInputSchema.safeParse(b);
      if (!parsed.success) {
        send({ status: 400, json: { error: parsed.error.issues[0]?.message ?? "参数非法" } });
        return true;
      }
      await csets.updateTemplate(code, parsed.data);
      send({ status: 200, json: { ok: true } });
      return true;
    }
    if (url === "/api/credential-values" && req.method === "GET") {
      const codes = await csets.listValueCodes(uid);
      const filled = await csets.getFilledValues(uid, codes);
      const byCode = new Map(filled.map((f) => [f.code, f]));
      const views: CredentialValueView[] = [];
      for (const code of codes) {
        const tpl = await csets.getTemplate(code);
        const entry = byCode.get(code);
        const values = entry?.values ?? {};
        const keySpecs = tpl?.keySpecs ?? [];
        views.push({
          code,
          name: entry?.name ?? tpl?.name ?? code,
          alias: entry?.name,
          description: tpl?.description,
          kind: tpl?.kind ?? "generic",
          keySpecs,
          filledKeys: keySpecs.filter((k) => values[k.key] !== undefined).map((k) => k.key),
          missingKeys: keySpecs.filter((k) => values[k.key] === undefined).map((k) => k.key),
          updatedAt: entry?.updatedAt ?? "",
        });
      }
      send({ status: 200, json: { credentials: views } });
      return true;
    }
    const valMatch = match(/^\/api\/credential-values\/([^/]+)$/);
    // PATCH /api/credential-values/:code —— 仅改本人显示名（别名）；values 是加密负载且
    // 前端永不持有，改名走独立端点避免要求重传值
    if (valMatch && req.method === "PATCH") {
      const code = decodeURIComponent(valMatch[1] ?? "");
      const b = JSON.parse(await this.readBody(req)) as Record<string, unknown>;
      const parsed = CredentialRenameInputSchema.safeParse(b);
      if (!parsed.success) {
        send({ status: 400, json: { error: parsed.error.issues[0]?.message ?? "参数非法" } });
        return true;
      }
      const ok = await csets.renameValue(uid, code, parsed.data.name);
      if (!ok) return notFound(`凭证 ${code} `);
      send({ status: 200, json: { ok: true } });
      return true;
    }
    if (valMatch && (req.method === "PUT" || req.method === "DELETE")) {
      const code = decodeURIComponent(valMatch[1] ?? "");
      if (req.method === "DELETE") {
        await csets.deleteValue(uid, code);
        send({ status: 200, json: { ok: true } });
        return true;
      }
      const tpl = await csets.getTemplate(code);
      if (!tpl) return notFound(`凭证模板 ${code} `);
      const b = JSON.parse(await this.readBody(req)) as Record<string, unknown>;
      const parsed = CredentialValueInputSchema.safeParse(b);
      if (!parsed.success) {
        send({ status: 400, json: { error: parsed.error.issues[0]?.message ?? "参数非法" } });
        return true;
      }
      await csets.upsertValue(uid, code, parsed.data.values);
      send({ status: 200, json: { ok: true } });
      return true;
    }
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
    return false;
  }

  /** 组装 skill-api 依赖；任一缺失返回 null（路由回 404）。 */
  private skillDeps(): SkillApiDeps | null {
    const { skillPackStore, installer } = this.deps;
    if (!skillPackStore || !installer) return null;
    return { packStore: skillPackStore, installer };
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
    const auth = req.headers.authorization;
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
      return JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString());
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
      connectorIds: a.connectorIds,
      credentials: a.credentials,
      gitRepositories: a.gitRepositories,
      extensionDirectories: a.extensionDirectories,
      // 编辑器需要的完整配置字段：漏传会让表单读到 undefined，保存时把默认值覆盖回库
      scenario: a.scenario,
      gitAllowShellGit: a.gitAllowShellGit,
      acceptanceGate: a.acceptanceGate,
      version: a.version,
      llm: a.llm,
    };
  }

  private maskRecord(rec: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.keys(rec).map((k) => [k, "••••"]));
  }

  /** 编辑器回传掩码占位时，用库内原密文值回填 */
  /** agent 装备告警：场景 preset 规则 + 凭证值存在性（不含任何值本身；warning 级不阻断） */
  private async agentEquipmentWarnings(actorId: string, agent: Agent): Promise<string[]> {
    const warnings = validateAgentAgainstPreset(agent).map((w) => `[${w.presetKey}] ${w.message}`);
    const csets = this.deps.credentialSets;
    if (csets && agent.credentials.length > 0) {
      const filled = await csets.getFilledValues(actorId, agent.credentials);
      const have = new Set(filled.map((f) => f.code));
      for (const code of agent.credentials) {
        if (!have.has(code)) warnings.push(`凭证 ${code} 的值尚未配置（执行时将触发问询）`);
      }
    }
    return warnings;
  }

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

  /**
   * agent.connectorIds 保存校验（spec 2026-09-11-connectors §3.3）：
   * 存在性 + 可见性（private 仅创建人）+ 引用集内无重名（连接器之间、与内联 mcpServers 之间）。
   * 返回错误信息（400）或 undefined。
   */
  private async validateAgentConnectorRefs(
    uid: string,
    input: Pick<Agent, "mcpServers"> & { connectorIds?: string[] },
  ): Promise<string | undefined> {
    const cstore = this.connectorStore;
    const ids = input.connectorIds ?? [];
    if (!cstore || ids.length === 0) return undefined;
    const connectors = await cstore.listByIds(ids);
    const missing = ids.filter((id) => !connectors.some((c) => c.id === id));
    if (missing.length > 0) return `连接器不存在: ${missing.join(", ")}`;
    const denied = connectors.filter((c) => c.shareScope !== "global" && c.ownerId !== uid);
    if (denied.length > 0) {
      return `连接器不可用（私有且非创建人）: ${denied.map((c) => c.name).join(", ")}`;
    }
    const seen = new Set<string>();
    const conflicts = new Set<string>();
    for (const c of connectors) {
      if (seen.has(c.name)) conflicts.add(c.name);
      seen.add(c.name);
    }
    for (const s of input.mcpServers) {
      if (seen.has(s.name)) conflicts.add(s.name);
    }
    if (conflicts.size > 0) {
      return `MCP 名称冲突（连接器/内联配置不可重名）: ${[...conflicts].join(", ")}`;
    }
    return undefined;
  }

  /** git 凭证绑定一致性：仓库级凭证（模板声明 repoUrl）必须与仓库地址一致（spec 2026-09-10 §3.3） */
  private async validateGitBindings(
    repositories: Agent["gitRepositories"],
  ): Promise<string | undefined> {
    const codes = [
      ...new Set(repositories.map((r) => r.credentialCode).filter((c): c is string => Boolean(c))),
    ];
    if (codes.length === 0 || !this.deps.credentialSets) return undefined;
    const credentialSets = this.deps.credentialSets;
    const templates = await Promise.all(codes.map((c) => credentialSets.getTemplate(c)));
    const byCode = new Map(
      codes
        .map((c, i) => [c, templates[i]] as const)
        .filter((entry): entry is [string, NonNullable<(typeof templates)[number]>] =>
          Boolean(entry[1]),
        ),
    );
    const errors = validateGitCredentialBindings(repositories, byCode);
    return errors.length > 0 ? errors.join("；") : undefined;
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
    // 内置智能体（assist/builder）不入库，无仓库配置，跳过 git 检查（否则 404 逃逸会打崩进程）
    if (
      conversation.agentId === BUILTIN_ASSIST_AGENT_ID ||
      conversation.agentId === AGENT_BUILDER_ID
    ) {
      return undefined;
    }
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
