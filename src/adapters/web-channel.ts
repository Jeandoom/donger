import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
import type { LlmTester } from "../adapters/llm-provider-tester.js";
import type { LlmPreset } from "../config.js";
import type { Viewer } from "../domain/access-policy.js";
import {
  type Agent,
  effectiveConversationScope,
  filterConversationsByScope,
  parseAgent,
  parseAgentInput,
  resolveDuplicateName,
} from "../domain/agent.js";
import { canManageAgent, canUseAgent } from "../domain/agent-policy.js";
import {
  type Connector,
  ConnectorInputSchema,
  collectCredentialRefs,
} from "../domain/connector.js";
import { substituteCredentialRefs } from "../domain/connector-resolution.js";
import type { Conversation } from "../domain/conversation.js";
import {
  CredentialRenameInputSchema,
  CredentialTemplateInputSchema,
  CredentialValueInputSchema,
  type CredentialValueView,
  parseCredentialCode,
  withGitPatKeySpecs,
} from "../domain/credential.js";
import {
  AgentExtensionDirectoriesInputSchema,
  isRelativeExtensionPath,
} from "../domain/extension-directory.js";
import {
  type Feedback,
  type FeedbackReply,
  isFeedbackCategory,
  isFeedbackStatus,
} from "../domain/feedback.js";
import { scopeRoots } from "../domain/file-browser.js";
import { mimeForExt } from "../domain/file-mime.js";
import type { AgentGitRepository } from "../domain/git.js";
import { validateGitCredentialBindings } from "../domain/git.js";
import {
  buildInvite,
  EMAIL_VERIFY_TTL_MS,
  inviteBlockReason,
  inviteQuotaExceeded,
  isEmailDomainAllowed,
  isValidEmail,
  monthStartIso,
  normalizeEmail,
  passwordPolicyError,
} from "../domain/invite.js";
import type { LLMConfig } from "../domain/llm-config.js";
import { LLM_PLATFORMS } from "../domain/llm-platforms.js";
import { resolveLlmOptions } from "../domain/llm-selection.js";
import { type Loop, parseLoopInput } from "../domain/loop.js";
import {
  CONVERSATION_MENTION_ALL_ID,
  conversationMarkerLabel,
  type MentionInput,
  MentionInputSchema,
  type ResolvedMention,
} from "../domain/mentions.js";
import { isModelRef, parseModelRef } from "../domain/model-ref.js";
import {
  type DingTalkModuleConfig,
  dingTalkLoginReady,
  dingTalkRobotReady,
  type GithubModuleConfig,
  parseSignupDomains,
} from "../domain/module-config.js";
import {
  type AgentPermissionMode,
  AgentPermissionModeSchema,
  resolvePermissionMode,
} from "../domain/permission-mode.js";
import { validateAgentAgainstPreset } from "../domain/scenario-preset.js";
import { parseTriggerInput, type Trigger } from "../domain/trigger.js";
import {
  type ApprovalCard,
  type IncomingMessage,
  type MessageFile,
  MessageFileSchema,
  type OutgoingMessage,
  type QuestionItem,
  type QuestionResolution,
} from "../domain/types.js";
import { wrapUntrusted } from "../domain/untrusted-content.js";
import type { User } from "../domain/user.js";
import { SidebarPrefsSchema } from "../domain/user.js";
import {
  normalizeLlmProviderInput,
  UserLlmProviderInputSchema,
} from "../domain/user-llm-provider.js";
import { parseWorkflowInput, type Workflow } from "../domain/workflow.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { ActivitySnapshot } from "../orchestrator/activity-tracker.js";
import { AGENT_BUILDER_AGENT, AGENT_BUILDER_ID } from "../orchestrator/agent-builder.js";
import { BUILTIN_ASSIST_AGENT, BUILTIN_ASSIST_AGENT_ID } from "../orchestrator/assist-agent.js";
import { BUILTIN_AUDITOR_AGENT, BUILTIN_AUDITOR_AGENT_ID } from "../orchestrator/auditor-agent.js";
import type { GitAccessCheck, GitAccessGate } from "../orchestrator/git-access-gate.js";
import type { HookRegistry } from "../orchestrator/hook-registry.js";
import type { LoopRunner } from "../orchestrator/loop-runner.js";
import { buildOptimizeBrief } from "../orchestrator/optimize-brief.js";
import type { SchedulerService } from "../orchestrator/scheduler.js";
import {
  BUILTIN_SELF_IMPROVER_AGENT_ID,
  buildSelfImproverAgent,
} from "../orchestrator/self-improver-agent.js";
import {
  BUILTIN_SKILL_FORGE_AGENT,
  BUILTIN_SKILL_FORGE_AGENT_ID,
} from "../orchestrator/skill-forge-agent.js";
import type { AgentCallbackStore } from "../ports/agent-callback-store.js";
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
import type { FeedbackStore } from "../ports/feedback-store.js";
import type { FileBrowser, FileScope } from "../ports/file-browser.js";
import type { InviteStore } from "../ports/invite-store.js";
import type { LlmDebugRunner } from "../ports/llm-debug-runner.js";
import type { LlmProviderStore } from "../ports/llm-provider-store.js";
import type { LoopStore } from "../ports/loop-store.js";
import type { MessageStore } from "../ports/message-store.js";
import type { SkillPackSource } from "../domain/skill-pack.js";
import type { ModuleConfigStore } from "../ports/module-config-store.js";
import { type RateLimiter, RateLimitKeys } from "../ports/rate-limiter.js";
import type { SessionStore } from "../ports/session-store.js";
import type { SkillInstaller } from "../ports/skill-installer.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";
import type { SystemEventStore } from "../ports/system-event-store.js";
import type { TaskStore } from "../ports/task-store.js";
import type { TriggerStore } from "../ports/trigger-store.js";
import type { UsageStore } from "../ports/usage-store.js";
import type { UserSkillRepoStore } from "../ports/user-skill-repo-store.js";
import type { UserStore } from "../ports/user-store.js";
import type { WorkflowStore } from "../ports/workflow-store.js";
import {
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from "../util/errors.js";
import {
  buildGithubAuthorizeUrl,
  configureGithubProxy,
  type GithubUserInfo,
  getGithubAccessToken,
  getGithubUser,
} from "../util/github-oauth-api.js";
import { hashPassword, verifyPassword } from "../util/password.js";
import { BUILTIN_TOOLS, discoverSkills } from "../util/skill-discovery.js";
import { ApiRouteGuard } from "./api-route-guard.js";
import { flattenWorkspaceFiles } from "./local-file-browser.js";
import { MemoryRateLimiter } from "./memory-rate-limiter.js";
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
import {
  handleGetSkillRepo,
  handlePutSkillRepo,
  handleSyncSkillRepo,
  handleVerifySkillRepo,
  type SkillRepoApiDeps,
} from "./skill-repo-api.js";
import type { SkillRepoSyncService } from "./skill-repo-sync.js";
import { buildWebRouteGuardSpecs } from "./web-route-guards.js";

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

/** 解析 dist 内真实文件；防路径穿越（必须仍落在 dist 内），不存在或非普通文件（目录等）返回 null */
function resolveRealFile(distRoot: string, urlPath: string): string | null {
  // join 会把开头的 "/" 当普通段拼接（resolve 则会当绝对路径跳出 dist）
  const resolved = resolve(join(distRoot, urlPath));
  // existsSync 对目录同样为 true——须 isFile 判定，否则 /assets/ 目录路径会直通
  // readFileSync 抛 EISDIR（未捕获即打死整个进程，2026-09-18 生产实测复现）
  try {
    return resolved.startsWith(distRoot + sep) && statSync(resolved).isFile() ? resolved : null;
  } catch {
    // statSync 理论上仅 ENOENT（exists 检查已隐含），其余异常按不可托管处理
    return null;
  }
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
  | { type: "tool_use"; toolUseId: string; tool: string; inputPreview: string }
  | { type: "tool_result"; toolUseId: string; outputPreview: string; isError: boolean }
  | { type: "approval_card"; gateId: string; title: string; summary: string }
  | {
      type: "credential_missing_card";
      reqId: string;
      conversationId: string;
      items: MissingCredentialItem[];
    }
  | {
      type: "ask_user_question";
      reqId: string;
      conversationId: string;
      questions: QuestionItem[];
    }
  | { type: "result"; subtype: "success" | "error"; text: string }
  | {
      type: "eviction_notice";
      taskId: string;
      conversationId: string;
      taskExcerpt: string;
      startedAt: string;
      pendingSince: string;
      canceledAt: string;
    }
  | { type: "error"; error: string };

/** 向 SSE 客户端写事件的回调 */
type SSEClient = {
  write(event: SSEEvent): void;
  close(): void;
};

/** 字符串截断（events 端点 light 模式用；空值原样返回） */
function clipStr(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** 附件上传上限：类型放开为任意文件后，仍需内存缓冲兜底（Busboy limits + data 累计双闸） */
const MAX_ATTACHMENT_MB = 20;
const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;

/** 上传文件名消毒：剥目录分量后清 Windows 非法字符/保留设备名/首尾点空，超长时保留扩展名截断 */
function sanitizeUploadName(raw: string): string {
  // 控制字符（<0x20）逐字替换，避免在正则里写控制字符字面量
  const noCtrl = Array.from(basename(raw))
    .map((ch) => (ch.charCodeAt(0) < 32 ? "_" : ch))
    .join("");
  let name = noCtrl
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/^[\s.]+/, "")
    .replace(/[\s.]+$/, "");
  const dot = name.lastIndexOf(".");
  const stem = dot <= 0 ? name : name.slice(0, dot);
  const ext = dot <= 0 ? "" : name.slice(dot);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) name = `_${stem}${ext}`;
  if (name.length > 120) name = `${name.slice(0, 120 - ext.length)}${ext}`;
  return name || "file";
}

/** meta/options 的技能分组（specs/2026-09-21-agent-config-llm-removal-skills-tree-design.md §4.1） */
export interface AgentSkillGroup {
  /** "builtin" | "pack:<packId>" */
  key: string;
  label: string;
  kind: "system" | "pack";
  description?: string;
  /** 人眼可辨的来源：Git 仓库 URL / 本地上传 / 粘贴创建 / 内置 */
  sourceLabel?: string;
  skills: Array<{ id: string; name: string; description?: string }>;
}

function skillPackSourceLabel(source: SkillPackSource): string {
  switch (source.kind) {
    case "git":
      return source.ref ? `Git 仓库（${source.url} @ ${source.ref}）` : `Git 仓库（${source.url}）`;
    case "upload":
      return "本地上传";
    case "paste":
      return "粘贴创建";
    case "builtin":
      return "内置";
  }
}

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
  /** 系统事件存储（审计页「事件」栏数据源；缺省=事件端点返回空列表） */
  systemEventStore?: SystemEventStore;
  conversationStore?: ConversationStore;
  messageStore?: MessageStore;
  usageStore?: UsageStore;
  auditStore?: AuditStore;
  commentStore?: CommentStore;
  /** 反馈模块存储（缺省=反馈端点 503） */
  feedbackStore?: FeedbackStore;
  sessionStore?: SessionStore;
  /** CLI 前端登录共享密钥（非空时启用 POST /api/auth/exchange） */
  cliToken?: string;
  fileBrowser?: FileBrowser;
  skillPackStore?: SkillPackStore;
  installer?: SkillInstaller;
  /** 用户技能仓库配置存储 + 同步服务（缺省=技能仓库端点 404） */
  userSkillRepoStore?: UserSkillRepoStore;
  skillRepoSync?: SkillRepoSyncService;
  credentialSets?: CredentialSetStore;
  /** 连接器（HTTP MCP 注册表）；缺省=端点不可用 */
  connectorStore?: ConnectorStore;
  /** 用户 LLM 供应商配置（多平台多配置）；缺省=模型配置端点不可用 */
  llmProviderStore?: LlmProviderStore;
  /** Anthropic 协议连通性校验；缺省=测试连接端点不可用 */
  llmProviderTester?: LlmTester;
  agentStore?: AgentStore;
  agentShareStore?: AgentShareStore;
  /** 智能体回调链接（缺省=回调端点不可用） */
  agentCallbackStore?: AgentCallbackStore;
  /** 会话忙碌查询（回调结果查询的 status 判定用）；缺省=一律视为不忙 */
  conversationBusyGetter?: (conversationId: string) => boolean;
  /** 回调链路专用投递：await 整轮、失败落 bot 错误消息（区别于普通通道的 fire-and-forget）；缺省=端点 503 */
  callbackSubmit?: (msg: IncomingMessage) => Promise<void>;
  /** 回调发起限流（次/分钟/token，默认 10） */
  callbackRateLimitPerMin?: number;
  gitAccessGate?: GitAccessGate;
  /** 平台进化官绑定的 donger 仓库（SELF_IMPROVE_GIT_URL；未配置=不绑仓库） */
  selfImproveGitRepository?: AgentGitRepository;
  /** 工作流模块（M14+M15+M6）—— 缺省=不支持 */
  triggerStore?: TriggerStore;
  workflowStore?: WorkflowStore;
  loopStore?: LoopStore;
  loopRunner?: LoopRunner;
  scheduler?: SchedulerService;
  hookRegistry?: HookRegistry;
  /** 会话实时执行状态查询（SDK 事件流推导，Observability 用）；缺省=端点 503 */
  activityGetter?: (conversationId: string) => ActivitySnapshot | undefined;
  /** 会话权限模式切换回调（PATCH 即时通知 orchestrator 内存 registry）；缺省=仅落库，下轮生效 */
  onPermissionModeChange?: (conversationId: string, mode: AgentPermissionMode) => void;
  publicBaseUrl?: string;
  agentMeta?: { presets: LlmPreset[]; skillPaths: string[] };
  llm?: LLMConfig;
  llmDebugRunner?: LlmDebugRunner;
  /** 模块化配置存储（授权/代理模块，spec 2026-09-21-auth-module-design）；缺省=三方登录端点不可用 */
  moduleConfigStore?: ModuleConfigStore;
  /**
   * 钉钉机器人消息通道运行时控制器：授权页「应用」即生效（重建/停用通道，无需重启）。
   * 由 index.ts 实现（需持有 skillPackStore 等以成对创建 channel+orchestrator）；缺省=仅登录配置生效。
   */
  dingtalkChannelController?: {
    apply(cfg: { appKey: string; appSecret: string; robotCode: string } | undefined): void;
  };
  /** SETUP_TOKEN 可选加固：配置后 setup 初始化管理员须携带该 token（首启打印到服务日志） */
  setupToken?: string;
  /** 邀请注册链接存储（缺省=邮箱注册/邀请端点不可用） */
  inviteStore?: InviteStore;
  /** 限流实现（缺省内存滑动窗口；单实例够用） */
  rateLimiter?: RateLimiter;
  /** 仅反代部署开启：限流取 X-Forwarded-For 首段而非 socket.remoteAddress */
  trustProxy?: boolean;
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
  private readonly agentCallbackStore?: AgentCallbackStore;
  private readonly connectorStore?: ConnectorStore;
  private readonly agentMeta?: { presets: LlmPreset[]; skillPaths: string[] };
  private readonly inviteStore?: InviteStore;
  private readonly oauthStateMap = new Map<string, number>();
  /** 限流（注册/登录 IP、登录失败锁定、llm-debug 配额）；缺省内存实现 */
  private readonly rateLimiter: RateLimiter;
  /** GitHub 绑定流程的 state → 意图（登录与绑定共用 authorize 端点，靠 state 区分） */
  private readonly githubBindStateMap = new Map<string, { userId: string; exp: number }>();
  /** 一次性登录 code → JWT（规格 M4：OAuth/验证回调 302 不再携带 token，60 秒单次有效） */
  private readonly oneTimeCodes = new Map<string, { token: string; exp: number }>();
  /** /api 路由守卫：授权单点收口，未登记路由一律 404（fail-closed） */
  private readonly routeGuard: ApiRouteGuard;

  constructor(private readonly deps: WebChannelDeps) {
    this.webRoot = deps.webRoot ?? join(__dirname, "..", "..", "web");
    this.workspaceDir = deps.workspaceDir;
    this.messageStore = deps.messageStore;
    this.sessionStore = deps.sessionStore;
    this.fileBrowser = deps.fileBrowser;
    this.agentStore = deps.agentStore;
    this.agentShareStore = deps.agentShareStore;
    this.agentCallbackStore = deps.agentCallbackStore;
    this.connectorStore = deps.connectorStore;
    this.agentMeta = deps.agentMeta;
    this.inviteStore = deps.inviteStore;
    this.rateLimiter = deps.rateLimiter ?? new MemoryRateLimiter();
    this.routeGuard = new ApiRouteGuard(
      buildWebRouteGuardSpecs({
        conversationStore: deps.conversationStore,
        taskStore: deps.taskStore,
        userStore: deps.userStore,
      }),
    );
  }

  /**
   * 鉴权 → Viewer：登录态取用户（含 role 供 owner/admin 判定）。
   * 未装配 sessionStore 的本地免认证模式视为全权本地用户（与既有分支语义一致）。
   */
  private async resolveViewer(req: HttpRequest): Promise<Viewer | null> {
    if (!this.sessionStore) return { id: "local", role: "admin" };
    const uid = await this.authMiddleware(req);
    if (!uid) return null;
    const user = await this.deps.userStore?.get(uid);
    return { id: uid, role: user?.role === "admin" ? "admin" : "user" };
  }

  /** 守卫通过后把 viewer 写回 req（userId 供既有 handler 取身份；viewer 供 role 判定） */
  private attachViewer(req: HttpRequest, viewer: Viewer | null): void {
    if (!viewer) return;
    const carrier = req as HttpRequest & { userId?: string; viewer?: Viewer };
    carrier.userId = viewer.id;
    carrier.viewer = viewer;
  }

  /** 取守卫注入的 viewer（未注入时按 member 兜底，防本地免认证路径下 role 判定失效） */
  private currentViewer(req: HttpRequest): Viewer {
    return (
      (req as HttpRequest & { viewer?: Viewer }).viewer ?? {
        id: (req as HttpRequest & { userId?: string }).userId ?? "",
        role: "user",
      }
    );
  }

  /**
   * 用户管理 DTO（spec 2026-09-21-user-management-design §2.1）：
   * 收敛信息面——不回 homeDir，identities 只留展示字段（externalId 为邮箱/平台 id，非机密）。
   */
  private async adminUserDto(id: string) {
    const store = this.deps.userStore;
    const user = store ? await store.get(id) : undefined;
    if (!user) return null;
    const identities = store ? await store.getIdentities(id) : [];
    return {
      id: user.id,
      name: user.name,
      role: user.role,
      avatar: user.avatar,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      identities: identities.map((i) => ({
        provider: i.provider,
        externalId: i.externalId,
        name: i.name,
        avatar: i.avatar,
      })),
    };
  }

  // === 模块化配置（授权/代理模块）生效读取：每请求直读 module_configs，保存即生效 ===

  private effectiveDingTalkLogin(): DingTalkModuleConfig | undefined {
    const cfg = this.deps.moduleConfigStore?.getDingTalk();
    return dingTalkLoginReady(cfg) ? cfg : undefined;
  }

  private effectiveGithub(): GithubModuleConfig | undefined {
    return this.deps.moduleConfigStore?.getGithub();
  }

  private effectiveEmail(): { signupAllowedDomains: Set<string>; loginEnabled: boolean } {
    const cfg = this.deps.moduleConfigStore?.getEmail();
    return {
      signupAllowedDomains: new Set(cfg?.signupAllowedDomains ?? []),
      loginEnabled: cfg?.loginEnabled !== false,
    };
  }

  /** setup 状态判定：无 admin 用户且未写 setup_completed 标记（spec §3.4；零 .env 引导入口） */
  private async isSetupRequired(): Promise<boolean> {
    if (!this.deps.userStore || !this.deps.moduleConfigStore) return false;
    if (await this.deps.userStore.hasAnyAdmin()) return false;
    return !this.deps.moduleConfigStore.getFlag("setup_completed");
  }

  /** 限流取 IP：TRUST_PROXY（反代部署）取 X-Forwarded-For 首段，否则 socket 直连地址 */
  private clientIp(req: HttpRequest): string {
    if (this.deps.trustProxy) {
      const xff = req.headers["x-forwarded-for"];
      const first = Array.isArray(xff) ? xff[0] : xff?.split(",")[0];
      if (first?.trim()) return first.trim();
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  /** 注册/登录限流：每 IP 每分钟 5 次（register 与 login 共用键） */
  private checkSignupRateLimit(ip: string): boolean {
    return this.rateLimiter.hit(RateLimitKeys.signup(ip), 60_000, 5);
  }

  /** 惰性清理过期的 OAuth state（登录与绑定共用），防 Map 无界增长 */
  private pruneOauthStates(): void {
    const now = Date.now();
    for (const [s, exp] of this.oauthStateMap) {
      if (now > exp) this.oauthStateMap.delete(s);
    }
    for (const [s, v] of this.githubBindStateMap) {
      if (now > v.exp) this.githubBindStateMap.delete(s);
    }
    for (const [c, v] of this.oneTimeCodes) {
      if (now > v.exp) this.oneTimeCodes.delete(c);
    }
  }

  /** 签发一次性登录 code（60 秒单次有效）：302 落地页拿 code 换 token，token 不进 URL/历史 */
  private issueOneTimeCode(token: string): string {
    this.pruneOauthStates();
    const code = randomBytes(24).toString("base64url");
    this.oneTimeCodes.set(code, { token, exp: Date.now() + 60_000 });
    return code;
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

  /** 结构化工具调用（turn UI）：广播 tool_use 事件，不落库（完整内容已落审计） */
  pushToolUse(
    conversationId: string,
    event: { toolUseId: string; tool: string; inputPreview: string },
  ): void {
    this.broadcastToConversation(conversationId, { type: "tool_use", ...event });
  }

  /** 结构化工具结果（turn UI）：成败都广播，前端工具卡片据此收敛状态 */
  pushToolResult(
    conversationId: string,
    event: { toolUseId: string; outputPreview: string; isError: boolean },
  ): void {
    this.broadcastToConversation(conversationId, { type: "tool_result", ...event });
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
    return new Promise((resolve) => {
      this.approvalStreams.set(card.gateId, {
        write: (_event: SSEEvent) => {},
        close: () => {},
      });

      // 审批不设超时：何时批由用户决定（人工评审可能数小时后处理）。挂起解除路径 =
      // 用户批/拒（HTTP respond）| 停止任务（cancelPendingApprovals 统一解开）| 服务重启清扫。
      // 注意：实际的审批响应通过 HTTP POST /api/approvals/:id/respond 处理
      // 这里返回一个占位 Promise，实际响应由 HTTP 处理器调用 resolve
      this.pendingApprovalResolves.set(card.gateId, {
        conversationId: threadId,
        resolve: (result) => {
          this.approvalStreams.delete(card.gateId);
          resolve(result);
        },
      });
    });
  }

  /** 任务停止/中断时解开该会话全部挂起审批：以「任务已中断」deny，runner 侧 abort 后不消费决策，仅解除 canUseTool await 让轮次可收口。 */
  cancelPendingApprovals(conversationId: string): void {
    for (const [gateId, pending] of this.pendingApprovalResolves) {
      if (pending.conversationId !== conversationId) continue;
      this.pendingApprovalResolves.delete(gateId);
      this.approvalStreams.delete(gateId);
      pending.resolve({ approved: false, reason: "任务已中断" });
    }
  }

  /** 并发淘汰通知：SSE 推给（新任务的）目标会话，前端弹窗展示被强制结束任务的详情 */
  pushEvictionNotice(
    conversationId: string,
    info: {
      taskId: string;
      conversationId: string;
      taskExcerpt: string;
      startedAt: string;
      pendingSince: string;
      canceledAt: string;
    },
  ): void {
    this.broadcastToConversation(conversationId, { type: "eviction_notice", ...info });
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

  /** AskUserQuestion 待作答 resolve（key=reqId；带会话归属供 owner 校验） */
  private readonly pendingQuestionResolves = new Map<
    string,
    {
      conversationId: string;
      questions: QuestionItem[];
      resolve: (result: QuestionResolution) => void;
    }
  >();

  /**
   * AskUserQuestion 问询：SSE 推 ask_user_question 卡片（前端锚定输入框上方渲染），
   * HTTP POST /api/user-inputs/:reqId/respond 回传答案。
   * 10 分钟无人作答 → 空答案降级（生命周期门同款放宽；模型按「未回答」分支继续）。
   */
  async requestUserInput(
    threadId: string,
    req: {
      taskId: string;
      conversationId: string;
      toolUseId: string;
      questions: QuestionItem[];
    },
  ): Promise<QuestionResolution> {
    void req.taskId;
    void req.toolUseId;
    const reqId = crypto.randomUUID();
    this.broadcastToConversation(threadId, {
      type: "ask_user_question",
      reqId,
      conversationId: threadId,
      questions: req.questions,
    });
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingQuestionResolves.delete(reqId);
        resolve({ answers: {}, timedOut: true });
      }, 600_000);
      this.pendingQuestionResolves.set(reqId, {
        conversationId: threadId,
        questions: req.questions,
        resolve: (result) => {
          clearTimeout(timeout);
          this.pendingQuestionResolves.delete(reqId);
          resolve(result);
        },
      });
    });
  }

  /** 当前会话待作答的问题（刷新后恢复卡片用；无则 null） */
  getPendingQuestion(conversationId: string): { reqId: string; questions: QuestionItem[] } | null {
    for (const [reqId, pending] of this.pendingQuestionResolves) {
      if (pending.conversationId === conversationId) {
        return { reqId, questions: pending.questions };
      }
    }
    return null;
  }

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

      // 授权单点收口：未登记路由 404（fail-closed），owner/admin 判定统一在此执行。
      // 守卫通过后写回 req.userId，下游 handler 既有取身份逻辑不变。
      const viewer = await this.resolveViewer(req);
      const guardResult = await this.routeGuard.check({
        method: req.method ?? "GET",
        pathname,
        viewer,
      });
      if (!guardResult.ok) {
        res.writeHead(guardResult.status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: guardResult.error }));
        return;
      }
      this.attachViewer(req, viewer);

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
        // AskUserQuestion 作答回传
        if (
          url.startsWith("/api/user-inputs/") &&
          req.method === "POST" &&
          url.endsWith("/respond")
        ) {
          await this.handleUserInputRespond(req, res);
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

    // /uploads/ 静态文件（规格 M4：附件不再无鉴权直出，须携带属主 token）
    if (url.startsWith("/uploads/")) {
      const uploadUser = await this.authMiddleware(req);
      if (!uploadUser) {
        res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("unauthorized");
        return;
      }
      // 剥离查询串（?token= 不得混入文件路径）
      const relPath = decodeURIComponent(url.split("?")[0]!.replace("/uploads/", ""));
      const [conversationId, ...fileParts] = relPath.split(/[\\/]/);
      const fileName = fileParts.join(sep);
      const attachmentDir = conversationId
        ? await this.resolveAttachmentDir(conversationId, uploadUser)
        : undefined;
      if (!attachmentDir) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("forbidden");
        return;
      }
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
        const mime = mimeForExt(ext);
        // 类型放开为任意文件后回读收口：位图与纯文本内联预览，其余（svg/html/pdf 等）
        // 一律 attachment 下载 + nosniff，杜绝上传文件在同源页面里执行脚本
        const inline = ext !== "svg" && (mime.startsWith("image/") || mime.startsWith("text/"));
        const savedName = basename(absPath);
        const asciiName = savedName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
        res.writeHead(200, {
          "Content-Type": mime,
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(savedName)}`,
        });
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
    if (target?.kind === "file") {
      // 读失败（残留句柄、权限等不可预期错误）降级 404，绝不让单个静态请求打死进程
      try {
        res.writeHead(200, { "Content-Type": contentType(target.absPath) });
        res.end(readFileSync(target.absPath));
      } catch (err) {
        console.warn("[web] 静态文件读取失败，降级 404:", url, err);
        if (!res.headersSent) {
          res.writeHead(404);
          res.end("Not found");
        }
      }
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

    // SSE 头（不带 CORS 通配：流内容含会话私密数据，跨站订阅一律拒绝）
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
    if (!pending) {
      // 审批决议的 resolver 在内存中；进程重启后原审批卡已失效（重启清扫会标失败任务）
      res.writeHead(404);
      res.end(JSON.stringify({ error: "approval not found or expired" }));
      return;
    }
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
   * POST /api/user-inputs/:reqId/respond
   * AskUserQuestion 作答回传：answers key=问题原文，单选=label，多选=label 逗号串。
   */
  private async handleUserInputRespond(req: HttpRequest, res: ServerResponse): Promise<void> {
    const match = req.url?.match(/^\/api\/user-inputs\/([\w-]+)\/respond$/);
    if (!match) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid user-input url" }));
      return;
    }
    const reqId = match[1] ?? "";

    let authUserId: string | undefined;
    if (this.sessionStore) {
      authUserId = (await this.authMiddleware(req)) ?? undefined;
      if (!authUserId) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    let body: { answers?: Record<string, string>; response?: string };
    try {
      body = JSON.parse(await this.readBody(req)) as {
        answers?: Record<string, string>;
        response?: string;
      };
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid json body" }));
      return;
    }
    if (typeof body !== "object" || body === null || typeof body.answers !== "object") {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "answers 必须是对象" }));
      return;
    }

    const pending = this.pendingQuestionResolves.get(reqId);
    if (!pending) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "question not found or expired" }));
      return;
    }
    const conv = await this.deps.conversationStore?.get(pending.conversationId);
    if (conv && authUserId && conv.userId !== authUserId) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "forbidden: 仅会话属主可作答" }));
      return;
    }
    this.pendingQuestionResolves.delete(reqId);
    pending.resolve({
      answers: body.answers ?? {},
      ...(body.response?.trim() ? { response: body.response.trim() } : {}),
    });
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
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
      mentions?: MentionInput[];
      modelRef?: unknown;
    };
    if (body.modelRef !== undefined && body.modelRef !== "") {
      if (typeof body.modelRef !== "string" || !isModelRef(body.modelRef)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "modelRef 格式非法" }));
        return;
      }
    }
    const parsedFiles = MessageFileSchema.array()
      .max(5)
      .safeParse(body.files ?? []);
    if (!parsedFiles.success) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "附件参数无效或超过 5 个" }));
      return;
    }
    const files = parsedFiles.data;
    const parsedMentions = MentionInputSchema.array()
      .max(20)
      .safeParse(body.mentions ?? []);
    if (!parsedMentions.success) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "引用参数无效或超过 20 条" }));
      return;
    }
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

    // 解析 @/​/$ 引用：文件换算为经校验的绝对路径，技能/连接器按 agent 实际装配集过滤
    // （fail-closed：未命中/越界的引用直接丢弃，不进 prompt）
    const mentions = await this.resolveMentions(requestUserId, conversationId, parsedMentions.data);

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
        ...(mentions.length > 0 ? { mentions } : {}),
        ...(typeof body.modelRef === "string" && body.modelRef ? { modelRef: body.modelRef } : {}),
      });
    }

    res.writeHead(202);
    res.end(JSON.stringify({ ok: true, conversationId }));
  }

  // ---------------------------------------------------------------------------
  // 智能体回调链接（specs/2026-09-15-agent-callback-design.md）
  // ---------------------------------------------------------------------------

  /** 回调端点的否定响应：统一随机延迟后返回，防时序探测 */
  private async callbackDeny(res: ServerResponse, status: number, error: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 100)));
    this.json(res, { error }, status);
  }

  /** 按 token 的滑动窗口限流（次/分钟）；内存态，单实例部署即够 */
  private readonly callbackRateBuckets = new Map<string, number[]>();
  private checkCallbackRateLimit(token: string): boolean {
    const limit = this.deps.callbackRateLimitPerMin ?? 10;
    const now = Date.now();
    const hits = (this.callbackRateBuckets.get(token) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= limit) {
      this.callbackRateBuckets.set(token, hits);
      return false;
    }
    hits.push(now);
    this.callbackRateBuckets.set(token, hits);
    return true;
  }

  /**
   * GET /api/callbacks/:token?query=xxx
   * 异步发起对话：创建 full_access 回调会话 + 投递 orchestrator，立即 202 返回 conversationId。
   */
  private async handleCallbackChat(
    req: HttpRequest,
    res: ServerResponse,
    token: string,
  ): Promise<void> {
    if (!this.agentCallbackStore || !this.deps.callbackSubmit || !this.deps.conversationStore) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "callback endpoint unavailable" }));
      return;
    }
    const cb = await this.agentCallbackStore.findByToken(token);
    if (!cb) return this.callbackDeny(res, 401, "invalid token");
    const a = await this.agentStore?.get(cb.agentId);
    if (!a) return this.callbackDeny(res, 404, "agent not found");
    if (cb.expiresAt && new Date(cb.expiresAt).getTime() <= Date.now()) {
      return this.callbackDeny(res, 410, "callback link expired");
    }
    const query = (this.extractQuery(req.url ?? "", "query") ?? "").trim();
    if (!query) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "query is required" }));
      return;
    }
    if (query.length > 4000) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "query too long (max 4000 chars)" }));
      return;
    }
    if (!this.checkCallbackRateLimit(token)) {
      res.writeHead(429);
      res.end(JSON.stringify({ error: "rate limited" }));
      return;
    }
    const conv = await this.deps.conversationStore.createWithAgent(
      cb.ownerId,
      "callback",
      `[回调] ${query.slice(0, 20)}`,
      cb.agentId,
      { permissionMode: "full_access" },
    );
    // 回调 query 是外部系统的不可信输入（规格 §5.1）：包装定界后再投递 agent
    const guardedQuery = wrapUntrusted(query, "callback").wrapped;
    // token↔会话绑定（规格 M4）：结果查询只放行该 token 发起的会话，堵跨 token 读他人回调结果
    await this.agentCallbackStore.recordConversation(token, conv.id);
    if (this.messageStore) {
      await this.messageStore
        .add(conv.id, "user", guardedQuery)
        .catch((e) => console.error("[web] 保存回调消息失败", e));
    }
    // callbackSubmit 内部 await 整轮并在失败时落 bot 错误消息；此处不等待（异步裁决）
    this.deps
      .callbackSubmit({
        channelId: "callback",
        threadId: conv.id,
        requesterId: cb.ownerId,
        text: guardedQuery,
        conversationId: conv.id,
      })
      .catch((e) => console.error("[web] 回调投递失败", e));
    this.json(res, { ok: true, conversationId: conv.id, status: "queued" }, 202);
  }

  /**
   * GET /api/callbacks/:token/conversations/:conversationId
   * 查回调会话执行结果：token 过期后仍可查；status = busy?running : 有 bot 回复?completed : queued。
   */
  private async handleCallbackResult(
    res: ServerResponse,
    token: string,
    conversationId: string,
  ): Promise<void> {
    if (!this.agentCallbackStore || !this.deps.conversationStore) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "callback endpoint unavailable" }));
      return;
    }
    const cb = await this.agentCallbackStore.findByToken(token);
    if (!cb) return this.callbackDeny(res, 401, "invalid token");
    const conv = await this.deps.conversationStore.get(conversationId);
    // 不区分「不存在」「不属于该 agent」「非本 token 发起」，统一 404 防会话枚举；
    // 绑定为空（升级前旧行）保持旧行为按 agentId 校验
    const bound = await this.agentCallbackStore.getLastConversationId(token);
    if (!conv || conv.agentId !== cb.agentId || (bound && bound !== conversationId)) {
      return this.callbackDeny(res, 404, "conversation not found");
    }
    const busy = this.deps.conversationBusyGetter?.(conversationId) ?? false;
    const msgs = (await this.messageStore?.listByConversation(conversationId)) ?? [];
    const hasBotReply = msgs.some((m) => m.role === "bot");
    const status = busy ? "running" : hasBotReply ? "completed" : "queued";
    this.json(res, {
      conversationId,
      status,
      messages: msgs.map((m) => ({ role: m.role, text: m.text, ts: m.createdAt })),
    });
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
    // 鉴权与授权已由 routeGuard 在 handleHttp 的 /api 入口统一执行（fail-closed）；
    // 本方法只做路由分发。公开性/属主/管理员规则见 web-route-guards.ts。
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

    // GET /api/setup/status —— 零配置引导状态（public；spec §3.4）
    if (url.split("?")[0] === "/api/setup/status" && req.method === "GET") {
      return this.json(res, { setupRequired: await this.isSetupRequired() });
    }

    // POST /api/setup/admin —— 初始化管理员（public+状态门+可选 SETUP_TOKEN；spec §3.4）
    if (url.split("?")[0] === "/api/setup/admin" && req.method === "POST") {
      if (!this.deps.userStore || !this.deps.moduleConfigStore || !this.sessionStore) {
        return this.json(res, { error: "服务未启用" }, 503);
      }
      const ip = req.socket.remoteAddress ?? "unknown";
      if (!this.checkSignupRateLimit(ip)) {
        return this.json(res, { error: "尝试过于频繁，请稍后再试" }, 429);
      }
      let body: { email?: unknown; password?: unknown; setupToken?: unknown };
      try {
        body = JSON.parse(await this.readBody(req));
      } catch {
        return this.json(res, { error: "请求格式无效" }, 400);
      }
      // SETUP_TOKEN 可选加固（拍板①）：配置后首启初始化须携带 token（部署者持服务器访问权即持 token）
      if (this.deps.setupToken) {
        const provided = Buffer.from(typeof body.setupToken === "string" ? body.setupToken : "");
        const expected = Buffer.from(this.deps.setupToken);
        const ok = provided.length === expected.length && timingSafeEqual(provided, expected);
        if (!ok) return this.json(res, { error: "初始化 token 无效" }, 403);
      }
      if (!(await this.isSetupRequired())) {
        return this.json(res, { error: "系统已完成初始化，请直接登录" }, 409);
      }
      const email = normalizeEmail(typeof body.email === "string" ? body.email : "");
      const password = typeof body.password === "string" ? body.password : "";
      if (!isValidEmail(email)) return this.json(res, { error: "邮箱格式无效" }, 400);
      const pwdErr = passwordPolicyError(password);
      if (pwdErr) return this.json(res, { error: pwdErr }, 400);
      const result = await this.deps.userStore.createBootstrapAdmin({
        email,
        passwordHash: hashPassword(password),
      });
      if (result === "exists") {
        return this.json(res, { error: "系统已完成初始化，请直接登录" }, 409);
      }
      const user = await this.deps.userStore.findByIdentity("email", email);
      if (!user) return this.json(res, { error: "初始化异常，请重试" }, 500);
      const { token } = await this.sessionStore.create(user.id);
      console.log(
        `[setup] 首个管理员已创建（${email}）；建议先到「授权」模块完成钉钉/GitHub 登录配置`,
      );
      return this.json(res, { token, user });
    }

    // GET /api/auth/methods —— 登录方式动态探测：按授权模块配置返回可用方式，
    // 顺序即展示优先级（邮箱 > 钉钉 > GitHub）；登录页据此渲染，未配置的方式不展示
    if (url === "/api/auth/methods" && req.method === "GET") {
      const methods: string[] = [];
      if (this.effectiveEmail().loginEnabled) methods.push("email");
      if (this.effectiveDingTalkLogin()) methods.push("dingtalk");
      if (this.effectiveGithub()) methods.push("github");
      const setupRequired = await this.isSetupRequired();
      this.json(res, { methods, setupRequired });
      return;
    }

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

    // POST /api/auth/code-exchange { code } —— 一次性 code 换 JWT（60 秒单次有效）
    if (url.split("?")[0] === "/api/auth/code-exchange" && req.method === "POST") {
      if (!this.sessionStore) return this.json(res, { error: "认证服务未启用" }, 503);
      let body: { code?: unknown };
      try {
        body = JSON.parse(await this.readBody(req));
      } catch {
        return this.json(res, { error: "请求格式无效" }, 400);
      }
      const code = typeof body.code === "string" ? body.code : "";
      const entry = code ? this.oneTimeCodes.get(code) : undefined;
      this.oneTimeCodes.delete(code);
      if (!entry || Date.now() > entry.exp) {
        return this.json(res, { error: "登录凭据已过期，请重新登录" }, 401);
      }
      return this.json(res, { token: entry.token });
    }

    // GET /api/auth/qrcode-url
    if (url === "/api/auth/qrcode-url" && req.method === "GET") {
      const dtCfg = this.effectiveDingTalkLogin();
      if (!dtCfg) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "钉钉登录未配置" }));
        return;
      }
      const state = `${Date.now()}-${Math.random()}`;
      this.oauthStateMap.set(state, Date.now() + 5 * 60 * 1000);
      for (const [s, exp] of this.oauthStateMap) {
        if (Date.now() > exp) this.oauthStateMap.delete(s);
      }
      const redirectUri =
        dtCfg.redirectUriOverride?.trim() || `${this.oauthBaseUrl()}/api/auth/dingtalk/callback`;
      const qrUrl = `https://login.dingtalk.com/oauth2/auth?redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&client_id=${encodeURIComponent(dtCfg.appKey)}&scope=${encodeURIComponent("openid corpid")}&state=${state}&prompt=consent`;
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
      // state 强校验（规格 M4）：CSRF 防护不可只告警不阻断；缺失/过期一律拒绝
      const stateExp = state ? this.oauthStateMap.get(state) : undefined;
      this.oauthStateMap.delete(state ?? "");
      if (!stateExp || Date.now() > stateExp) {
        console.warn("[auth] OAuth state 校验失败或过期:", state);
        res.writeHead(302, {
          Location: `/login?error=${encodeURIComponent("登录会话已过期，请重新扫码")}`,
        });
        res.end();
        return;
      }

      const dtCfg = this.effectiveDingTalkLogin();
      if (!dtCfg || !this.deps.userStore || !this.sessionStore) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "认证服务未就绪" }));
        return;
      }

      try {
        const { getUserAccessToken, getUserInfoByOAuth } = await import("../util/dingtalk-api.js");
        const tokenResult = await getUserAccessToken(dtCfg.appKey, dtCfg.appSecret, code);
        const userInfo = await getUserInfoByOAuth(tokenResult.accessToken);
        // 统一身份模型：直接按 identity 查找/创建并绑定，不再走合并流程。
        const user = await this.deps.userStore.getOrCreateByIdentity(
          "dingtalk",
          userInfo.userId,
          userInfo.name,
          userInfo.avatar,
        );
        const { token } = await this.sessionStore.create(user.id);
        res.writeHead(302, {
          Location: `/login/success?code=${this.issueOneTimeCode(token)}`,
        });
        res.end();
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error("[auth] 钉钉回调处理失败:", errMsg);
        res.writeHead(302, { Location: `/login?error=${encodeURIComponent(errMsg)}` });
        res.end();
      }
      return;
    }

    // GET /api/auth/github/url —— 生成 GitHub 授权跳转 URL（登录用）
    if (url === "/api/auth/github/url" && req.method === "GET") {
      const ghCfg = this.effectiveGithub();
      if (!ghCfg) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "GitHub 登录未配置" }));
        return;
      }
      const state = `${Date.now()}-${Math.random()}`;
      this.oauthStateMap.set(state, Date.now() + 5 * 60 * 1000);
      this.pruneOauthStates();
      this.json(res, {
        url: buildGithubAuthorizeUrl({
          clientId: ghCfg.clientId,
          redirectUri: this.githubRedirectUri(ghCfg),
          state,
        }),
      });
      return;
    }

    // GET /api/auth/github/bind —— 已登录用户发起 GitHub 身份绑定（经统一鉴权段取 userId）
    if (url === "/api/auth/github/bind" && req.method === "GET") {
      const ghCfg = this.effectiveGithub();
      if (!ghCfg) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "GitHub 登录未配置" }));
        return;
      }
      const userId = this.requireRequestUser(req);
      const state = `${Date.now()}-${Math.random()}`;
      this.githubBindStateMap.set(state, { userId, exp: Date.now() + 5 * 60 * 1000 });
      this.pruneOauthStates();
      this.json(res, {
        url: buildGithubAuthorizeUrl({
          clientId: ghCfg.clientId,
          redirectUri: this.githubRedirectUri(ghCfg),
          state,
        }),
      });
      return;
    }

    // GET /api/auth/github/callback —— 授权回调：按 state 区分登录（创建/复用账号）与绑定（addIdentity）
    if (url.startsWith("/api/auth/github/callback") && req.method === "GET") {
      const code = this.extractQuery(url, "code");
      const state = this.extractQuery(url, "state");
      if (!code || !state) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "缺少 code/state 参数" }));
        return;
      }
      const ghCfg = this.effectiveGithub();
      if (!ghCfg || !this.deps.userStore || !this.sessionStore) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "认证服务未就绪" }));
        return;
      }
      try {
        // 绑定流程：state 命中绑定意图
        const bind = this.githubBindStateMap.get(state);
        if (bind) {
          this.githubBindStateMap.delete(state);
          if (Date.now() > bind.exp) throw new Error("绑定会话已过期，请重新发起绑定");
          const info = await this.fetchGithubUser(ghCfg, code);
          const owner = await this.deps.userStore.findByIdentity("github", info.id);
          if (owner && owner.id !== bind.userId) {
            throw new Error("该 GitHub 账号已绑定其他用户");
          }
          if (!owner) {
            await this.deps.userStore.addIdentity(bind.userId, {
              id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              userId: bind.userId,
              provider: "github",
              externalId: info.id,
              name: info.name ?? info.login,
              avatar: info.avatarUrl,
              createdAt: new Date().toISOString(),
            });
          }
          const { token } = await this.sessionStore.create(bind.userId);
          res.writeHead(302, {
            Location: `/login/success?code=${this.issueOneTimeCode(token)}&mode=bind&provider=github`,
          });
          res.end();
          return;
        }
        // 登录流程：state 强校验（GitHub OAuth 规范要求；钉钉侧维持既有弱校验不动）
        const exp = this.oauthStateMap.get(state);
        this.oauthStateMap.delete(state);
        if (!exp || Date.now() > exp) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "state 校验失败，请重新发起登录" }));
          return;
        }
        const info = await this.fetchGithubUser(ghCfg, code);
        const user = await this.deps.userStore.getOrCreateByIdentity(
          "github",
          info.id,
          info.name ?? info.login,
          info.avatarUrl,
        );
        const { token } = await this.sessionStore.create(user.id);
        res.writeHead(302, {
          Location: `/login/success?code=${this.issueOneTimeCode(token)}`,
        });
        res.end();
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error("[auth] GitHub 回调处理失败:", errMsg);
        res.writeHead(302, { Location: `/login?error=${encodeURIComponent(errMsg)}` });
        res.end();
      }
      return;
    }

    // === 邮箱注册/登录（防 robot：域名白名单 + 邀请链接 + IP 限流） ===

    // POST /api/auth/register { email, password, invite? }
    if (url.split("?")[0] === "/api/auth/register" && req.method === "POST") {
      if (!this.deps.userStore || !this.inviteStore || !this.sessionStore) {
        return this.json(res, { error: "注册服务未启用" }, 503);
      }
      const ip = req.socket.remoteAddress ?? "unknown";
      if (!this.checkSignupRateLimit(ip)) {
        return this.json(res, { error: "尝试过于频繁，请稍后再试" }, 429);
      }
      let body: { email?: unknown; password?: unknown; invite?: unknown };
      try {
        body = JSON.parse(await this.readBody(req));
      } catch {
        return this.json(res, { error: "请求格式无效" }, 400);
      }
      const email = normalizeEmail(typeof body.email === "string" ? body.email : "");
      const password = typeof body.password === "string" ? body.password : "";
      if (!isValidEmail(email)) return this.json(res, { error: "邮箱格式无效" }, 400);
      const pwdErr = passwordPolicyError(password);
      if (pwdErr) return this.json(res, { error: pwdErr }, 400);

      const inviteToken = typeof body.invite === "string" ? body.invite.trim() : "";
      const invite = inviteToken ? await this.inviteStore.getByToken(inviteToken) : undefined;
      if (inviteToken) {
        const reason = invite ? inviteBlockReason(invite, new Date()) : "邀请链接无效";
        if (reason) return this.json(res, { error: reason }, 403);
      } else if (!isEmailDomainAllowed(email, this.effectiveEmail().signupAllowedDomains)) {
        return this.json(res, { error: "该邮箱域名不在允许注册范围，请使用邀请链接注册" }, 403);
      }

      const existing = await this.deps.userStore.findByIdentity("email", email);
      if (existing) {
        // 过期未验证的 pending 账号允许复注册（裁决②：24h 不验证即失效）；其余 409 防枚举
        const v = await this.deps.userStore.getEmailVerification(existing.id);
        const expired =
          v && !v.verified && v.expiresAt !== null && new Date(v.expiresAt).getTime() <= Date.now();
        if (!expired) return this.json(res, { error: "该邮箱已注册，请直接登录" }, 409);
      }

      if (inviteToken) {
        // 原子核销（防并发超用）；步骤上方已做格式与查重校验，核销失败视为被并发用完
        const consumed = await this.inviteStore.consume(inviteToken, new Date());
        if (!consumed) return this.json(res, { error: "邀请链接使用次数已用完" }, 403);
      }

      const name = email.split("@")[0] ?? email;
      const user = await this.deps.userStore.getOrCreateByIdentity("email", email, name);
      await this.deps.userStore.setPasswordCredential(user.id, hashPassword(password));
      // 验证状态机（裁决①方案 B / ②）：pending 不发 token；验证链接由管理员线下转交；
      // 24h 不验证即失效（可凭新注册复活）。一期不接 SMTP，注册响应不含链接。
      const verifyToken = randomBytes(24).toString("base64url");
      await this.deps.userStore.setEmailVerification(user.id, {
        token: verifyToken,
        expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS).toISOString(),
      });
      return this.json(
        res,
        {
          ok: true,
          message: "注册已受理，请通过管理员提供的验证链接完成邮箱验证（24 小时内有效）",
        },
        202,
      );
    }

    // POST /api/auth/login { email, password }
    if (url.split("?")[0] === "/api/auth/login" && req.method === "POST") {
      if (!this.deps.userStore || !this.sessionStore) {
        return this.json(res, { error: "登录服务未启用" }, 503);
      }
      const ip = req.socket.remoteAddress ?? "unknown";
      if (!this.checkSignupRateLimit(ip)) {
        return this.json(res, { error: "尝试过于频繁，请稍后再试" }, 429);
      }
      let body: { email?: unknown; password?: unknown };
      try {
        body = JSON.parse(await this.readBody(req));
      } catch {
        return this.json(res, { error: "请求格式无效" }, 400);
      }
      const email = normalizeEmail(typeof body.email === "string" ? body.email : "");
      const password = typeof body.password === "string" ? body.password : "";
      // 账号级锁定：连续失败达限后该邮箱登录被锁（窗口自然解封），防分布式 IP 绕过 IP 限流
      if (this.rateLimiter.count(RateLimitKeys.loginFail(email), 15 * 60_000) >= 5) {
        return this.json(res, { error: "失败次数过多，请稍后再试" }, 429);
      }
      // 不区分「邮箱不存在」与「密码错误」，防账号枚举
      const user = await this.deps.userStore.findByIdentity("email", email);
      const storedHash = user
        ? await this.deps.userStore.getPasswordCredential(user.id)
        : undefined;
      if (!user || !storedHash || !verifyPassword(password, storedHash)) {
        this.rateLimiter.hit(RateLimitKeys.loginFail(email), 15 * 60_000, 5);
        return this.json(res, { error: "邮箱或密码错误" }, 401);
      }
      // 验证状态机（规格 §6.1）：未验证不放行；过期即失效（不宽限）
      const v = await this.deps.userStore.getEmailVerification(user.id);
      if (v && !v.verified) {
        const expired = v.expiresAt !== null && new Date(v.expiresAt).getTime() <= Date.now();
        return this.json(
          res,
          {
            error: expired
              ? "邮箱验证已过期，该账号已失效，请重新注册"
              : "邮箱尚未验证，请通过管理员提供的验证链接完成验证",
          },
          401,
        );
      }
      const { token } = await this.sessionStore.create(user.id);
      return this.json(res, { token, user });
    }

    // GET /api/auth/verify?token=xxx —— 邮箱验证核销（公开路由；成功即登录）
    if (url.split("?")[0] === "/api/auth/verify" && req.method === "GET") {
      if (!this.deps.userStore || !this.sessionStore) {
        return this.json(res, { error: "验证服务未启用" }, 503);
      }
      const token = this.extractQuery(url, "token") ?? "";
      const userId = token ? await this.deps.userStore.markEmailVerified(token) : undefined;
      if (!userId) {
        res.writeHead(302, {
          Location: `/login?error=${encodeURIComponent("验证链接无效或已过期")}`,
        });
        res.end();
        return;
      }
      const user = await this.deps.userStore.get(userId);
      const { token: jwt } = await this.sessionStore.create(userId);
      res.writeHead(302, {
        Location: `/login/success?code=${this.issueOneTimeCode(jwt)}&mode=verified`,
      });
      res.end();
      return;
    }

    // GET /api/admin/email-verifications —— pending/过期账号及验证链接（admin；方案 B 转交数据源）
    if (url.split("?")[0] === "/api/admin/email-verifications" && req.method === "GET") {
      if (!this.deps.userStore) return this.json(res, { error: "服务未启用" }, 503);
      const rows = await this.deps.userStore.listEmailVerifications();
      const verifications = rows.map((r) => ({
        userId: r.userId,
        email: r.email,
        verified: r.verified,
        expiresAt: r.expiresAt,
        expired:
          !r.verified && r.expiresAt !== null && new Date(r.expiresAt).getTime() <= Date.now(),
        verifyPath: !r.verified && r.token ? `/api/auth/verify?token=${r.token}` : null,
      }));
      return this.json(res, { verifications });
    }

    // === 授权/代理模块配置（admin；spec 2026-09-21-auth-module-design §3.3/§3.6） ===
    // 语义：PUT 合并保存（秘密留空=保留旧值，掩码不回显）+「应用」即生效（登录每请求读库；
    // 钉钉机器人通道经 controller 运行时换血；代理经 configureGithubProxy 幂等重配）。

    // GET /api/admin/auth-configs —— 三模块配置视图（秘密只回 appSecretSet，不回明文）
    if (url.split("?")[0] === "/api/admin/auth-configs" && req.method === "GET") {
      if (!this.deps.moduleConfigStore) return this.json(res, { error: "服务未启用" }, 503);
      const store = this.deps.moduleConfigStore;
      const dt = store.getDingTalk();
      const gh = store.getGithub();
      const email = store.getEmail();
      const rawDt = store.rawModule("dingtalk");
      const rawGh = store.rawModule("github");
      const dtCallback = dt
        ? dt.redirectUriOverride?.trim() || `${this.oauthBaseUrl()}/api/auth/dingtalk/callback`
        : `${this.oauthBaseUrl()}/api/auth/dingtalk/callback`;
      const ghCallback = gh
        ? this.githubRedirectUri(gh)
        : `${this.oauthBaseUrl()}/api/auth/github/callback`;
      return this.json(res, {
        dingtalk: dt
          ? {
              appKey: dt.appKey,
              appSecretSet: true,
              robotCode: dt.robotCode ?? "",
              cardTemplateId: dt.cardTemplateId ?? "",
              callbackUrl: dtCallback,
            }
          : {
              appKey: "",
              appSecretSet: !!rawDt?.appSecret,
              robotCode: "",
              cardTemplateId: "",
              callbackUrl: dtCallback,
            },
        github: gh
          ? { clientId: gh.clientId, clientSecretSet: true, callbackUrl: ghCallback }
          : { clientId: "", clientSecretSet: !!rawGh?.clientSecret, callbackUrl: ghCallback },
        email: {
          signupAllowedDomains: email?.signupAllowedDomains ?? [],
          loginEnabled: email?.loginEnabled !== false,
        },
      });
    }

    // PUT /api/admin/auth-configs/dingtalk —— 保存+机器人通道运行时生效；清空保存=停用
    if (url.split("?")[0] === "/api/admin/auth-configs/dingtalk" && req.method === "PUT") {
      if (!this.deps.moduleConfigStore) return this.json(res, { error: "服务未启用" }, 503);
      let body: {
        appKey?: unknown;
        appSecret?: unknown;
        robotCode?: unknown;
        cardTemplateId?: unknown;
      };
      try {
        body = JSON.parse(await this.readBody(req));
      } catch {
        return this.json(res, { error: "请求格式无效" }, 400);
      }
      const store = this.deps.moduleConfigStore;
      const prev = store.getDingTalk();
      const appKey = typeof body.appKey === "string" ? body.appKey.trim() : "";
      // 秘密留空=保留旧值（掩码合并语义，同凭证页）
      const appSecret =
        typeof body.appSecret === "string" && body.appSecret
          ? body.appSecret
          : (prev?.appSecret ?? "");
      if (!appKey) {
        if (prev) {
          // AppKey 留空=停用：删配置并停掉机器人通道
          store.deleteModule("dingtalk");
          this.deps.dingtalkChannelController?.apply(undefined);
          return this.json(res, { ok: true, robotChannelActive: false });
        }
        return this.json(res, { error: "请填写 AppKey 与 AppSecret" }, 400);
      }
      if (!appSecret) return this.json(res, { error: "请填写 AppSecret" }, 400);
      const robotCode = typeof body.robotCode === "string" ? body.robotCode.trim() : "";
      const cardTemplateId =
        typeof body.cardTemplateId === "string" ? body.cardTemplateId.trim() : "";
      store.putDingTalk({
        appKey,
        appSecret,
        ...(robotCode ? { robotCode } : {}),
        ...(cardTemplateId ? { cardTemplateId } : {}),
      });
      // 「应用」即生效：机器人通道运行时换血（登录能力本就每请求读库）
      const saved = store.getDingTalk();
      this.deps.dingtalkChannelController?.apply(
        saved && dingTalkRobotReady(saved)
          ? { appKey: saved.appKey, appSecret: saved.appSecret, robotCode: saved.robotCode ?? "" }
          : undefined,
      );
      return this.json(res, { ok: true, robotChannelActive: dingTalkRobotReady(saved) });
    }

    // PUT /api/admin/auth-configs/github
    if (url.split("?")[0] === "/api/admin/auth-configs/github" && req.method === "PUT") {
      if (!this.deps.moduleConfigStore) return this.json(res, { error: "服务未启用" }, 503);
      let body: { clientId?: unknown; clientSecret?: unknown };
      try {
        body = JSON.parse(await this.readBody(req));
      } catch {
        return this.json(res, { error: "请求格式无效" }, 400);
      }
      const store = this.deps.moduleConfigStore;
      const prev = store.getGithub();
      const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
      const clientSecret =
        typeof body.clientSecret === "string" && body.clientSecret
          ? body.clientSecret
          : (prev?.clientSecret ?? "");
      if (!clientId) {
        if (prev) {
          // Client ID 留空=停用 GitHub 登录/绑定
          store.deleteModule("github");
          return this.json(res, { ok: true });
        }
        return this.json(res, { error: "请填写 Client ID 与 Client Secret" }, 400);
      }
      if (!clientSecret) return this.json(res, { error: "请填写 Client Secret" }, 400);
      store.putGithub({ clientId, clientSecret });
      return this.json(res, { ok: true });
    }

    // PUT /api/admin/auth-configs/email —— 域名白名单 + 登录开关
    if (url.split("?")[0] === "/api/admin/auth-configs/email" && req.method === "PUT") {
      if (!this.deps.moduleConfigStore) return this.json(res, { error: "服务未启用" }, 503);
      let body: { signupAllowedDomains?: unknown; loginEnabled?: unknown };
      try {
        body = JSON.parse(await this.readBody(req));
      } catch {
        return this.json(res, { error: "请求格式无效" }, 400);
      }
      const rawDomains = body.signupAllowedDomains;
      // 前端 textarea 原文（字符串）或数组均可，parseSignupDomains 统一解析
      if (typeof rawDomains !== "string" && !Array.isArray(rawDomains)) {
        return this.json(res, { error: "signupAllowedDomains 须为字符串或字符串数组" }, 400);
      }
      this.deps.moduleConfigStore.putEmail({
        signupAllowedDomains: parseSignupDomains(rawDomains),
        loginEnabled: body.loginEnabled !== false,
      });
      return this.json(res, { ok: true });
    }

    // GET /api/admin/proxy —— 代理模块视图
    if (url.split("?")[0] === "/api/admin/proxy" && req.method === "GET") {
      if (!this.deps.moduleConfigStore) return this.json(res, { error: "服务未启用" }, 503);
      const proxy = this.deps.moduleConfigStore.getProxy();
      return this.json(res, { githubOauthProxyUrl: proxy?.githubOauthProxyUrl ?? "" });
    }

    // PUT /api/admin/proxy —— 保存+configureGithubProxy 即时生效（新请求即走新代理）
    if (url.split("?")[0] === "/api/admin/proxy" && req.method === "PUT") {
      if (!this.deps.moduleConfigStore) return this.json(res, { error: "服务未启用" }, 503);
      let body: { githubOauthProxyUrl?: unknown };
      try {
        body = JSON.parse(await this.readBody(req));
      } catch {
        return this.json(res, { error: "请求格式无效" }, 400);
      }
      const proxyUrl =
        typeof body.githubOauthProxyUrl === "string" ? body.githubOauthProxyUrl.trim() : "";
      if (proxyUrl && !/^https?:\/\//.test(proxyUrl)) {
        return this.json(res, { error: "代理地址须为 http(s):// 形式" }, 400);
      }
      this.deps.moduleConfigStore.putProxy(proxyUrl ? { githubOauthProxyUrl: proxyUrl } : {});
      configureGithubProxy(proxyUrl || undefined);
      return this.json(res, { ok: true });
    }

    // === 用户管理（admin；spec 2026-09-21-user-management-design §2.1） ===

    // GET /api/admin/users —— 全量用户 DTO 列表（不回 homeDir；附登录方式绑定）
    if (url.split("?")[0] === "/api/admin/users" && req.method === "GET") {
      if (!this.deps.userStore) return this.json(res, { error: "服务未启用" }, 503);
      const users = await this.deps.userStore.list();
      const rows = await Promise.all(users.map(async (u) => this.adminUserDto(u.id)));
      return this.json(res, rows);
    }

    // PATCH /api/admin/users/:id/role —— 授予/取消管理员（写路径唯一入口）
    // 防锁死三守卫：禁自改 → 白名单保护 → 禁降最后一位 admin（P0：admin 清零会重开 setup 引导）
    const userRoleMatch = url.match(/^\/api\/admin\/users\/([\w.-]+)\/role(?:\?.*)?$/);
    if (userRoleMatch && req.method === "PATCH") {
      const store = this.deps.userStore;
      if (!store) return this.json(res, { error: "服务未启用" }, 503);
      let body: { role?: unknown };
      try {
        body = JSON.parse(await this.readBody(req));
      } catch {
        return this.json(res, { error: "请求格式无效" }, 400);
      }
      const role = body.role;
      if (role !== "admin" && role !== "user") {
        return this.json(res, { error: "role 须为 admin 或 user" }, 400);
      }
      const targetId = userRoleMatch[1] ?? "";
      const viewer = this.currentViewer(req);
      if (targetId === viewer.id) {
        return this.json(res, { error: "不能变更自己的角色" }, 409);
      }
      const target = await store.get(targetId);
      if (!target) return this.json(res, { error: "user not found" }, 404);
      if (target.role !== role) {
        if (role === "user") {
          // 白名单保护：ADMIN_EXTERNAL_IDS 授予的 admin 不可页面取消（防语义漂移+数据面保险）
          const identities = await store.getIdentities(targetId);
          for (const ident of identities) {
            if (await store.isAdminByExternalId(ident.provider, ident.externalId)) {
              return this.json(
                res,
                {
                  error:
                    "该用户由 ADMIN_EXTERNAL_IDS 白名单授予管理员，无法在页面取消；如需取消请先从服务端配置移除对应条目",
                },
                409,
              );
            }
          }
          if (!(await store.hasAnyAdminExcluding(targetId))) {
            return this.json(res, { error: "至少保留一位管理员" }, 409);
          }
        }
        const prevRole = target.role;
        await store.updateRole(targetId, role);
        // 系统事件留痕（审计页「事件」栏；决策③）
        const actor = await store.get(viewer.id);
        await this.deps.systemEventStore?.record({
          type: "user_role_change",
          actorId: viewer.id,
          actorName: actor?.name ?? viewer.id,
          targetUserId: targetId,
          targetUserName: target.name,
          detail: `${actor?.name ?? viewer.id} 将 ${target.name} 的角色从 ${prevRole} 变更为 ${role}`,
        });
      }
      return this.json(res, { user: await this.adminUserDto(targetId) });
    }

    // GET /api/admin/system-events —— 系统重要事件（审计页「事件」栏；admin 专属）
    if (url.split("?")[0] === "/api/admin/system-events" && req.method === "GET") {
      const events = (await this.deps.systemEventStore?.list(200)) ?? [];
      return this.json(res, { events });
    }

    // GET /api/invites —— 当前用户的邀请列表
    if (url.split("?")[0] === "/api/invites" && req.method === "GET") {
      if (!this.inviteStore) return this.json(res, { error: "邀请服务未启用" }, 503);
      const userId = this.requireRequestUser(req);
      return this.json(res, { invites: await this.inviteStore.listByCreator(userId) });
    }

    // POST /api/invites { expiresInDays?, maxUses? } —— 生成邀请
    if (url.split("?")[0] === "/api/invites" && req.method === "POST") {
      if (!this.inviteStore) return this.json(res, { error: "邀请服务未启用" }, 503);
      const userId = this.requireRequestUser(req);
      // 月度配额（裁决⑤）：每账号每自然月最多 30 个，按创建计数判定
      const createdThisMonth = (await this.inviteStore.listByCreator(userId)).filter(
        (i) => i.createdAt >= monthStartIso(),
      ).length;
      if (inviteQuotaExceeded(createdThisMonth)) {
        return this.json(res, { error: "本月邀请额度已用完（每账号每月 30 个）" }, 429);
      }
      let body: { expiresInDays?: unknown; maxUses?: unknown } = {};
      try {
        body = JSON.parse(await this.readBody(req));
      } catch {
        // 空 body 视为默认值
      }
      const invite = buildInvite({
        createdBy: userId,
        expiresInDays: typeof body.expiresInDays === "number" ? body.expiresInDays : 7,
        maxUses: typeof body.maxUses === "number" ? body.maxUses : 1,
      });
      await this.inviteStore.create(invite);
      return this.json(res, { invite }, 201);
    }

    // POST /api/invites/:id/disable —— 属主禁用邀请
    {
      const disableMatch = url.split("?")[0]?.match(/^\/api\/invites\/([\w-]+)\/disable$/);
      if (disableMatch && req.method === "POST") {
        if (!this.inviteStore) return this.json(res, { error: "邀请服务未启用" }, 503);
        const userId = this.requireRequestUser(req);
        const ok = await this.inviteStore.disable(disableMatch[1] ?? "", userId);
        return this.json(res, ok ? { ok: true } : { error: "邀请不存在" }, ok ? 200 : 404);
      }
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
            starredAgentIds: user.starredAgentIds ?? [],
            agentOrder: user.agentOrder ?? [],
          },
          identities,
        }),
      );
      return;
    }

    // PATCH /api/users/me/sidebar-prefs —— 对话模块侧栏偏好（星标置顶/分组排序；仅本人，全量替换）
    if (url === "/api/users/me/sidebar-prefs" && req.method === "PATCH") {
      if (!this.deps.userStore) return this.json(res, { error: "user store 未启用" }, 503);
      const uid = this.requireRequestUser(req);
      const parsed = SidebarPrefsSchema.safeParse(JSON.parse(await this.readBody(req)));
      if (!parsed.success) {
        return this.json(
          res,
          { error: "sidebar prefs 无效（starredAgentIds/agentOrder 须为字符串数组）" },
          400,
        );
      }
      await this.deps.userStore.updateSidebarPrefs(uid, parsed.data);
      return this.json(res, { ok: true, ...parsed.data });
    }

    // —— 用户 LLM 供应商多配置（specs/2026-09-18-llm-multi-provider-design.md §6）——
    if (url === "/api/settings/llm-platforms" && req.method === "GET") {
      return this.json(res, { platforms: LLM_PLATFORMS });
    }

    const llmProviderPath = url.split("?")[0] ?? url;
    // 集合路径（字符串精确匹配）在前、id 正则在后：路由覆盖扫描按邻近行归因 method，
    // 顺序颠倒会把集合分支的 method 错算进 id 正则（test/security/route-coverage.test.ts）。

    // GET /api/settings/llm-providers：列表（不含 key）+ 系统默认模型（.env，仅名称）
    if (llmProviderPath === "/api/settings/llm-providers" && req.method === "GET") {
      const userId = this.requireRequestUser(req);
      const store = this.deps.llmProviderStore;
      if (!store) return this.json(res, { error: "模型配置服务未启用" }, 503);
      const providers = await store.list(userId);
      return this.json(res, {
        providers,
        systemDefaultModel: this.deps.llm?.model ?? "",
        systemPresets: (this.agentMeta?.presets ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          model: p.model,
        })),
      });
    }

    // POST /api/settings/llm-providers：新建（key 必填；平台锁定 baseUrl/sdkType）
    if (llmProviderPath === "/api/settings/llm-providers" && req.method === "POST") {
      const userId = this.requireRequestUser(req);
      const store = this.deps.llmProviderStore;
      if (!store) return this.json(res, { error: "模型配置服务未启用" }, 503);
      const parsed = UserLlmProviderInputSchema.safeParse(JSON.parse(await this.readBody(req)));
      if (!parsed.success) {
        return this.json(res, { error: parsed.error.issues[0]?.message ?? "参数无效" }, 400);
      }
      const key = parsed.data.key.trim();
      if (!key) return this.json(res, { error: "API Key 不能为空" }, 400);
      const normalized = normalizeLlmProviderInput(parsed.data);
      if ("error" in normalized) return this.json(res, { error: normalized.error }, 400);
      const created = await store.create(userId, {
        ...normalized,
        key,
        isDefault: parsed.data.isDefault,
      });
      return this.json(res, created, 201);
    }

    const llmProviderIdMatch = llmProviderPath.match(/^\/api\/settings\/llm-providers\/([\w-]+)$/);

    // PUT /api/settings/llm-providers/:id：更新（key 留空 = 保持原值）
    if (llmProviderIdMatch && req.method === "PUT") {
      const userId = this.requireRequestUser(req);
      const store = this.deps.llmProviderStore;
      if (!store) return this.json(res, { error: "模型配置服务未启用" }, 503);
      const id = llmProviderIdMatch[1] ?? "";
      const body = JSON.parse(await this.readBody(req)) as Record<string, unknown>;
      const existing = await store.getWithKey(userId, id);
      if (!existing) return this.json(res, { error: "配置不存在" }, 404);
      const merged = {
        name: typeof body.name === "string" ? body.name : existing.name,
        platform: existing.platform,
        baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : existing.baseUrl,
        key: typeof body.key === "string" && body.key.trim() ? body.key : "",
        models: Array.isArray(body.models) ? body.models : existing.models,
        sdkType: existing.sdkType,
        isDefault: typeof body.isDefault === "boolean" ? body.isDefault : existing.isDefault,
      };
      const parsed = UserLlmProviderInputSchema.safeParse(merged);
      if (!parsed.success) {
        return this.json(res, { error: parsed.error.issues[0]?.message ?? "参数无效" }, 400);
      }
      const normalized = normalizeLlmProviderInput(parsed.data);
      if ("error" in normalized) return this.json(res, { error: normalized.error }, 400);
      // baseUrl/sdkType 校验后仍以归一化结果落库（custom 平台可改 baseUrl）
      const updated = await store.update(userId, id, {
        name: normalized.name,
        baseUrl: normalized.baseUrl,
        ...(parsed.data.key ? { key: parsed.data.key.trim() } : {}),
        models: normalized.models,
        isDefault: parsed.data.isDefault,
      });
      if (!updated) return this.json(res, { error: "配置不存在" }, 404);
      return this.json(res, updated);
    }

    // DELETE /api/settings/llm-providers/:id
    if (llmProviderIdMatch && req.method === "DELETE") {
      const userId = this.requireRequestUser(req);
      const store = this.deps.llmProviderStore;
      if (!store) return this.json(res, { error: "模型配置服务未启用" }, 503);
      const id = llmProviderIdMatch[1] ?? "";
      const removed = await store.remove(userId, id);
      if (!removed) return this.json(res, { error: "配置不存在" }, 404);
      return this.json(res, { ok: true });
    }

    // POST /api/settings/llm-providers/:id/test：Anthropic 协议连通性校验（限流防 key 探测滥用）
    const llmProviderTestMatch = llmProviderPath.match(
      /^\/api\/settings\/llm-providers\/([\w-]+)\/test$/,
    );
    if (llmProviderTestMatch && req.method === "POST") {
      const userId = this.requireRequestUser(req);
      if (!this.rateLimiter.hit(RateLimitKeys.llmProviderTest(userId), 60_000, 10)) {
        return this.json(res, { error: "请求过于频繁，请稍后再试" }, 429);
      }
      const store = this.deps.llmProviderStore;
      const tester = this.deps.llmProviderTester;
      if (!store || !tester) return this.json(res, { error: "测试服务未启用" }, 503);
      const provider = await store.getWithKey(userId, llmProviderTestMatch[1] ?? "");
      if (!provider) return this.json(res, { error: "配置不存在" }, 404);
      const model = provider.models[0] ?? "";
      if (!model) return this.json(res, { error: "该配置没有可用模型" }, 400);
      const result = await tester.test({ baseUrl: provider.baseUrl, key: provider.key, model });
      return this.json(res, result);
    }

    // GET /api/conversations/:id/llm-options —— 对话底栏可选模型集（恒为全量：
    // 系统默认 + presets + 访问者自己的 provider 配置；agent 侧模型范围已退役）
    const llmOptionsMatch = llmProviderPath.match(/^\/api\/conversations\/([\w-]+)\/llm-options$/);
    if (llmOptionsMatch && req.method === "GET") {
      const userId = this.requireRequestUser(req);
      const conversation = await this.deps.conversationStore?.getVisible(
        userId,
        llmOptionsMatch[1] ?? "",
      );
      if (!conversation) return this.json(res, { error: "会话不存在或不属于当前用户" }, 404);
      const providers = (await this.deps.llmProviderStore?.list(userId)) ?? [];
      const options = resolveLlmOptions({
        providers,
        presets: this.agentMeta?.presets ?? [],
        systemDefaultModel: this.deps.llm?.model ?? "",
      });
      return this.json(res, {
        options,
        current: conversation.lastModelRef ?? "",
      });
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

    // GET /api/tasks（兼容 ?status= 查询串）——按 viewer 过滤（admin 全量）
    if (url.split("?")[0] === "/api/tasks" && req.method === "GET") {
      const viewer = this.currentViewer(req);
      const isAdmin = viewer.role === "admin";
      const status = this.extractQuery(url, "status");
      // L2 纵深防御：member 走 store 层强制过滤（规格 §4）
      const collect = async (s: string) => {
        if (isAdmin) return (await this.deps.taskStore?.listByStatus(s as never)) ?? [];
        return (await this.deps.taskStore?.listVisible(viewer.id, s as never)) ?? [];
      };
      const tasks = status
        ? await collect(status)
        : [
            ...(await collect("done")),
            ...(await collect("failed")),
            ...(await collect("running")),
            ...(await collect("created")),
          ];
      res.writeHead(200);
      res.end(JSON.stringify(tasks));
      return;
    }

    // GET /api/tasks/:id
    const taskMatch = url.match(/^\/api\/tasks\/([\w-]+)$/);
    if (taskMatch && req.method === "GET") {
      const viewer = this.currentViewer(req);
      const task =
        viewer.role === "admin"
          ? await this.deps.taskStore?.get(taskMatch[1] ?? "")
          : await this.deps.taskStore?.getVisible(viewer.id, taskMatch[1] ?? "");
      res.writeHead(task ? 200 : 404);
      res.end(JSON.stringify(task ?? { error: "not found" }));
      return;
    }

    // GET /api/tasks/:id/events —— 该任务全量审计事件（T17.3 观测数据源）
    const taskEventsMatch = url.match(/^\/api\/tasks\/([\w-]+)\/events$/);
    if (taskEventsMatch && req.method === "GET") {
      const viewer = this.currentViewer(req);
      const store = this.deps.auditStore;
      const events =
        viewer.role === "admin"
          ? ((await store?.listByTask(taskEventsMatch[1] ?? "")) ?? [])
          : ((await store?.listByTaskVisible(viewer.id, taskEventsMatch[1] ?? "")) ?? []);
      res.writeHead(200);
      res.end(JSON.stringify(events));
      return;
    }

    // GET/POST /api/tasks/:id/comments —— 任务评论（T17.3 观测/反馈闭环）
    const taskCommentsMatch = url.match(/^\/api\/tasks\/([\w-]+)\/comments$/);
    if (taskCommentsMatch) {
      const taskId = taskCommentsMatch[1] ?? "";
      if (req.method === "GET") {
        // L2：非属主不可读评论列表（属主判定经任务 store；admin 直通）
        const viewer = this.currentViewer(req);
        const visibleTask =
          viewer.role === "admin"
            ? await this.deps.taskStore?.get(taskId)
            : await this.deps.taskStore?.getVisible(viewer.id, taskId);
        if (!visibleTask) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
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
      // L2：getVisible 语义即"非属主视为不存在"，与原 requesterId 校验等价
      const task = await this.deps.taskStore?.getVisible(uid, taskId);
      if (!task) return this.json(res, { error: "task not found" }, 404);
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

      // 任务专属会话 get-or-create：优化材料（他人路径附件、审计摘要）不混入用户已有
      // 闲聊/任务历史；同一任务重复点击复用同一会话（按标题精确匹配）
      const convTitle = `优化分析 ${task.id.slice(0, 8)}`.slice(0, 30);
      const list = (await this.deps.conversationStore?.listByUser(uid)) ?? [];
      let conv = list.find((c) => c.agentId === BUILTIN_ASSIST_AGENT_ID && c.title === convTitle);
      if (!conv) {
        conv = await this.deps.conversationStore?.createWithAgent(
          uid,
          "web",
          convTitle,
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

    // GET /api/conversations/:id/activity — 会话实时执行状态（SDK 事件流推导；属主判定由 routeGuard 执行）
    const activityMatch = url.match(/^\/api\/conversations\/([\w-]+)\/activity$/);
    if (activityMatch && req.method === "GET") {
      if (!this.deps.activityGetter) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "activity 服务未启用" }));
        return;
      }
      const conversationId = activityMatch[1] ?? "";
      const activity = this.deps.activityGetter(conversationId);
      res.writeHead(activity ? 200 : 204);
      res.end(activity ? JSON.stringify({ activity }) : "");
      return;
    }

    // GET /api/conversations/:id/messages — 会话消息列表
    // GET /api/conversations/:id/events[?light=1] —— 会话执行事件回放（audit 统一事件源；属主判定由 routeGuard 执行）
    const eventsMatch = url.match(/^\/api\/conversations\/([\w-]+)\/events(?:\?.*)?$/);
    if (eventsMatch && req.method === "GET") {
      const conversationId = eventsMatch[1] ?? "";
      const viewer = this.currentViewer(req);
      const store = this.deps.auditStore;
      const all =
        viewer.role === "admin"
          ? ((await store?.listByConversation(conversationId)) ?? [])
          : ((await store?.listByConversationVisible(viewer.id, conversationId)) ?? []);
      // llm_input/llm_output 是调试级原始消息（体积大、含系统提示），不入回放流
      const light = this.extractQuery(url, "light") === "1";
      const events = all
        .filter((e) => e.type !== "llm_input" && e.type !== "llm_output")
        .map((e) =>
          light
            ? {
                ...e,
                // 轻量模式：工具出入参截断（turn UI 历史装配只需摘要；完整内容按需走观测面板）
                toolInput: clipStr(e.toolInput, 2000),
                toolOutput: clipStr(e.toolOutput, 2000),
              }
            : e,
        );
      this.json(res, { events });
      return;
    }

    // GET /api/conversations/:id/pending-question — 待作答问题（刷新后恢复锚定卡片；属主判定由 routeGuard 执行）
    const pendingQMatch = url.match(/^\/api\/conversations\/([\w-]+)\/pending-question$/);
    if (pendingQMatch && req.method === "GET") {
      const conversationId = pendingQMatch[1] ?? "";
      const pending = this.getPendingQuestion(conversationId);
      this.json(res, { question: pending });
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
        createdAt: m.createdAt,
        taskId: m.taskId ?? null,
        files: JSON.parse(m.files) as Array<{
          path: string;
          name: string;
          type: "image" | "markdown" | "document";
        }>,
      }));
      res.writeHead(200);
      res.end(JSON.stringify(messages));
      return;
    }

    // GET /api/conversations —— 仅本人会话列表（admin 可经 ?userId= 代查）
    if (url.startsWith("/api/conversations") && req.method === "GET") {
      const viewer = this.currentViewer(req);
      const requested = this.extractQuery(url, "userId");
      const userId = viewer.role === "admin" && requested ? requested : viewer.id;
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
        const withMode = await Promise.all(list.map((c) => this.conversationWithMode(c)));
        res.writeHead(200);
        res.end(JSON.stringify(withMode));
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

    // POST /api/conversations —— 会话归属强制为当前登录者（防代他人建会话）
    if (url === "/api/conversations" && req.method === "POST") {
      const body = await this.readBody(req);
      const { channelId, agentId } = JSON.parse(body) as {
        userId?: string;
        channelId?: string;
        agentId?: string;
      };
      const userId = this.requireRequestUser(req);
      if (this.deps.userStore) {
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

    // PATCH /api/conversations/:id — 会话权限模式覆盖（属主/管理员判定由 routeGuard owner 规则执行）
    const patchConvMatch = url.match(/^\/api\/conversations\/([\w-]+)$/);
    if (patchConvMatch && req.method === "PATCH") {
      const conversationId = patchConvMatch[1] ?? "";
      const viewer = this.currentViewer(req);
      const conv =
        viewer.role === "admin"
          ? await this.deps.conversationStore?.get(conversationId)
          : await this.deps.conversationStore?.getVisible(viewer.id, conversationId);
      if (!conv) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "conversation not found" }));
        return;
      }
      const body = JSON.parse(await this.readBody(req)) as { permissionMode?: string };
      const parsed = AgentPermissionModeSchema.safeParse(body.permissionMode);
      if (!parsed.success) {
        res.writeHead(400);
        res.end(
          JSON.stringify({ error: "permissionMode 无效（ask_before_change | full_access）" }),
        );
        return;
      }
      const previous = conv.permissionMode ?? "ask_before_change（跟随智能体默认）";
      await this.deps.conversationStore?.update(conversationId, { permissionMode: parsed.data });
      // 内存 registry 即时更新：进行中轮的下一次工具调用即按新模式校验
      this.deps.onPermissionModeChange?.(conversationId, parsed.data);
      try {
        await this.deps.auditStore?.record({
          conversationId,
          taskId: "",
          userId: viewer.id,
          seq: -1,
          type: "permission_mode_change",
          text: `会话权限模式：${previous} → ${parsed.data}`,
          toolInput: JSON.stringify({ from: conv.permissionMode, to: parsed.data }),
          recordedAt: new Date().toISOString(),
        });
      } catch {
        // 审计失败不阻断切换
      }
      this.json(res, { ok: true, permissionMode: parsed.data });
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

    // GET /api/audit/conversations —— admin 全量；member 仅本人会话（store 层 L2 visible 过滤）
    if (url === "/api/audit/conversations" && req.method === "GET") {
      const viewer = this.currentViewer(req);
      const summaries =
        viewer.role === "admin"
          ? ((await this.deps.auditStore?.listConversationSummaries()) ?? [])
          : ((await this.deps.auditStore?.listConversationSummariesVisible(viewer.id)) ?? []);
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

    // POST /api/llm/debug：用已配置模型对编辑后的历史输入做隔离调试调用（限流防 LLM 配额滥用）
    if (url === "/api/llm/debug" && req.method === "POST") {
      if (!this.rateLimiter.hit(RateLimitKeys.llmDebug(this.requireRequestUser(req)), 60_000, 10)) {
        return this.json(res, { error: "请求过于频繁，请稍后再试" }, 429);
      }
      const body = JSON.parse(await this.readBody(req)) as {
        input?: unknown;
        presetId?: unknown;
        modelRef?: unknown;
      };
      if (typeof body.input !== "string" || !body.input.trim()) {
        this.json(res, { error: "input is required" }, 400);
        return;
      }
      if (!this.deps.llm || !this.deps.llmDebugRunner) {
        this.json(res, { error: "LLM debug runner is not configured" }, 503);
        return;
      }
      // modelRef（system|preset:x|provider:id:model）优先；兼容旧 presetId 入参
      const modelRef = typeof body.modelRef === "string" ? body.modelRef : undefined;
      const presetId = typeof body.presetId === "string" ? body.presetId : undefined;
      let llm: LLMConfig = this.deps.llm;
      if (modelRef) {
        const parsed = parseModelRef(modelRef);
        if (!parsed) {
          this.json(res, { error: "modelRef 格式非法" }, 400);
          return;
        }
        if (parsed.kind === "preset") {
          const preset = this.agentMeta?.presets.find((item) => item.id === parsed.id);
          if (!preset) {
            this.json(res, { error: "unknown LLM preset" }, 400);
            return;
          }
          llm = { ...llm, model: preset.model, baseUrl: preset.baseUrl };
        } else if (parsed.kind === "provider") {
          const userId = this.requireRequestUser(req);
          const provider = await this.deps.llmProviderStore?.getWithKey(userId, parsed.providerId);
          if (!provider?.models.includes(parsed.model)) {
            this.json(res, { error: "模型配置不存在或不含该模型" }, 400);
            return;
          }
          llm = { model: parsed.model, baseUrl: provider.baseUrl, authToken: provider.key };
        }
      } else if (presetId) {
        const preset = this.agentMeta?.presets.find((item) => item.id === presetId);
        if (!preset) {
          this.json(res, { error: "unknown LLM preset" }, 400);
          return;
        }
        llm = { ...llm, model: preset.model, baseUrl: preset.baseUrl };
      }
      const result = await this.deps.llmDebugRunner.run(body.input, llm);
      this.json(res, { ...result, model: llm.model }, 200);
      return;
    }

    // GET /api/audit/conversations/:id —— 守卫已限属主或 admin；member 再走 L2 visible 双保险
    const auditDetailMatch = url.match(/^\/api\/audit\/conversations\/([\w-]+)$/);
    if (auditDetailMatch && req.method === "GET") {
      const conversationId = auditDetailMatch[1] ?? "";
      const viewer = this.currentViewer(req);
      const events =
        viewer.role === "admin"
          ? ((await this.deps.auditStore?.listByConversation(conversationId)) ?? [])
          : ((await this.deps.auditStore?.listByConversationVisible(viewer.id, conversationId)) ??
            []);
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

    // ===== 反馈模块（spec 2026-09-20-feedback-module-design；守卫已登记 8 条）=====

    // POST /api/feedback —— 创建反馈；userId 强制取当前登录者（防代他人提交）
    if (url === "/api/feedback" && req.method === "POST") {
      if (!this.deps.feedbackStore) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "反馈服务未启用" }));
        return;
      }
      const uid = this.requireRequestUser(req);
      // R4 防刷量：每用户每小时 10 条
      if (!this.rateLimiter.hit(RateLimitKeys.feedback(uid), 60 * 60_000, 10)) {
        res.writeHead(429);
        res.end(JSON.stringify({ error: "提交过于频繁，请稍后再试" }));
        return;
      }
      const body = JSON.parse(await this.readBody(req)) as {
        category?: unknown;
        content?: unknown;
        images?: unknown;
        key?: unknown;
      };
      const content = typeof body.content === "string" ? body.content.trim() : "";
      if (!content || content.length > 2000) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "content 必填且不超过 2000 字" }));
        return;
      }
      const category =
        body.category === undefined || body.category === null || body.category === ""
          ? "other"
          : body.category;
      if (!isFeedbackCategory(category)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "category 无效" }));
        return;
      }
      const images = this.sanitizeFeedbackImages(body.images);
      if (images === undefined) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "images 无效（须为文件名数组，≤3 项）" }));
        return;
      }
      const now = new Date().toISOString();
      const feedback: Feedback = {
        id: crypto.randomUUID(),
        userId: uid,
        category,
        content,
        images,
        status: "open",
        createdAt: now,
        updatedAt: now,
      };
      await this.deps.feedbackStore.create(feedback);
      // 上传草稿目录收编为正式附件目录（无图时目录不存在，静默跳过）
      this.adoptFeedbackAttachments(typeof body.key === "string" ? body.key : "", feedback.id);
      res.writeHead(201);
      res.end(JSON.stringify(feedback));
      return;
    }

    // GET /api/feedback —— admin 全量 / member 仅本人；DTO 附提交人姓名（admin 列表展示用）
    if ((url === "/api/feedback" || url.startsWith("/api/feedback?")) && req.method === "GET") {
      const viewer = this.currentViewer(req);
      const items =
        viewer.role === "admin"
          ? ((await this.deps.feedbackStore?.listAll()) ?? [])
          : ((await this.deps.feedbackStore?.listByUser(viewer.id)) ?? []);
      const nameCache = new Map<string, string>();
      const itemsWithUser = await Promise.all(
        items.map(async (fb) => {
          let userName = nameCache.get(fb.userId);
          if (userName === undefined) {
            userName = (await this.deps.userStore?.get(fb.userId))?.name ?? fb.userId;
            nameCache.set(fb.userId, userName);
          }
          return { ...fb, userName };
        }),
      );
      res.writeHead(200);
      res.end(JSON.stringify({ items: itemsWithUser }));
      return;
    }

    // POST /api/feedback/attachments —— 反馈截图上传（落 ?key= 草稿目录，创建反馈时收编）
    if (url.startsWith("/api/feedback/attachments") && req.method === "POST") {
      await this.handleFeedbackUpload(req, res);
      return;
    }

    // GET /api/feedback/:id —— 详情；owner ∥ admin，否则 404 掩护存在性
    const feedbackDetailMatch = url.match(/^\/api\/feedback\/([\w-]+)$/);
    if (feedbackDetailMatch && req.method === "GET") {
      const fb = await this.requireVisibleFeedback(req, feedbackDetailMatch[1] ?? "");
      if (!fb) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(fb));
      return;
    }

    // PATCH /api/feedback/:id/status —— 状态流转（守卫已收口 admin，handler 不再重复判角色）
    const feedbackStatusMatch = url.match(/^\/api\/feedback\/([\w-]+)\/status$/);
    if (feedbackStatusMatch && req.method === "PATCH") {
      const store = this.deps.feedbackStore;
      if (!store) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "反馈服务未启用" }));
        return;
      }
      const id = feedbackStatusMatch[1] ?? "";
      if (!(await store.get(id))) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const body = JSON.parse(await this.readBody(req)) as { status?: unknown };
      if (!isFeedbackStatus(body.status)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "status 无效" }));
        return;
      }
      await store.updateStatus(id, body.status);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET/POST /api/feedback/:id/replies —— 回复时间线（admin=官方回复 / 属主=补充说明）
    const feedbackRepliesMatch = url.match(/^\/api\/feedback\/([\w-]+)\/replies$/);
    if (feedbackRepliesMatch) {
      const id = feedbackRepliesMatch[1] ?? "";
      if (req.method === "GET") {
        const fb = await this.requireVisibleFeedback(req, id);
        if (!fb) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        const replies = (await this.deps.feedbackStore?.listReplies(id)) ?? [];
        res.writeHead(200);
        res.end(JSON.stringify({ replies }));
        return;
      }
      if (req.method === "POST") {
        const store = this.deps.feedbackStore;
        if (!store) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: "反馈服务未启用" }));
          return;
        }
        const fb = await this.requireVisibleFeedback(req, id);
        if (!fb) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        const viewer = this.currentViewer(req);
        const body = JSON.parse(await this.readBody(req)) as { content?: unknown };
        const content = typeof body.content === "string" ? body.content.trim() : "";
        if (!content || content.length > 2000) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "content 必填且不超过 2000 字" }));
          return;
        }
        const reply: FeedbackReply = {
          id: crypto.randomUUID(),
          feedbackId: id,
          userId: viewer.id,
          // 服务端按 viewer.role 落库，不信任客户端入参
          authorRole: viewer.role === "admin" ? "admin" : "user",
          content,
          createdAt: new Date().toISOString(),
        };
        await store.addReply(reply);
        res.writeHead(201);
        res.end(JSON.stringify(reply));
        return;
      }
    }

    // GET /api/feedback/:id/attachments/:name —— 图片回读（img 标签 ?token= 鉴权；
    // owner ∥ admin；文件名上传时已 ASCII 安全化）。name 段收窄 [\w.-]：? 不在集合内，
    // 查询串由 (?:\?.*)? 兜住，不会污染捕获组
    const feedbackFileMatch = url.match(
      /^\/api\/feedback\/([\w-]+)\/attachments\/([\w.-]+)(?:\?.*)?$/,
    );
    if (feedbackFileMatch && req.method === "GET") {
      const fb = await this.requireVisibleFeedback(req, feedbackFileMatch[1] ?? "");
      const absPath = fb
        ? this.resolveFeedbackAttachment(fb.id, feedbackFileMatch[2] ?? "")
        : undefined;
      if (!absPath || !existsSync(absPath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = absPath.split(".").pop()?.toLowerCase() ?? "";
      res.writeHead(200, { "Content-Type": mimeForExt(ext) });
      res.end(readFileSync(absPath));
      return;
    }

    // GET /api/usage —— 默认仅本人记录；admin 可显式传 userId 查任意用户
    if ((url === "/api/usage" || url.startsWith("/api/usage?")) && req.method === "GET") {
      const viewer = this.currentViewer(req);
      const requested = this.extractQuery(url, "userId");
      const userId = viewer.role === "admin" ? requested : viewer.id;
      // L2 纵深防御：member 恒走 listByUser（store 层强制过滤）
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
        viewer.role === "admin" || !viewer.id
          ? ((await this.deps.usageStore?.list({ userId, taskId, since, until, limit })) ?? [])
          : ((await this.deps.usageStore?.listByUser(viewer.id, { taskId, since, until, limit })) ??
            []);
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
      const skillGroups = await this.discoverAgentSkillGroups(userId);
      const seen = new Set<string>();
      return this.json(res, {
        // 扁平候选保留一个版本期（分组视图的展开去重，内置组在前）
        skills: skillGroups
          .flatMap((group) => group.skills)
          .filter((option) => {
            if (seen.has(option.id)) return false;
            seen.add(option.id);
            return true;
          }),
        skillGroups,
        tools: BUILTIN_TOOLS,
        // 审计页调试重放选模型在用（AuditPage）；agent 编辑器已不消费
        llmPresets: this.agentMeta?.presets ?? [],
      });
    }
    // GET /api/agents/:id/mention-candidates?q=&conversationId= —— 输入框 @/​/$/% 引用候选（可用者 = owner/被分享/admin）
    const mentionCandidatesPathname = url.split("?")[0] ?? url;
    const mentionCandidatesMatch = mentionCandidatesPathname.match(
      /^\/api\/agents\/([\w-]+)\/mention-candidates$/,
    );
    if (mentionCandidatesMatch && req.method === "GET") {
      const id = mentionCandidatesMatch[1] ?? "";
      const me = this.requireUserId(req);
      const a = await this.agentStore?.get(id);
      if (!a) return this.json(res, { error: "not found" }, 404);
      const meUser = await this.deps.userStore?.get(me);
      const actor = { id: me, role: (meUser?.role ?? "user") as "admin" | "user" };
      const granted = this.agentShareStore ? await this.agentShareStore.isGranted(id, me) : false;
      if (!canUseAgent(a, actor, granted)) return this.json(res, { error: "forbidden" }, 403);
      const q = this.extractQuery(url, "q") ?? "";
      const convId = this.extractQuery(url, "conversationId") ?? "";
      return this.json(
        res,
        await this.mentionCandidates(me, a, q, convId.length > 0 ? convId : undefined),
      );
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
      // 分享收紧：版本历史属于配置面，被分享者不可见（仅自有/admin）
      if (!canManageAgent(a, actor)) return this.json(res, { error: "forbidden" }, 403);
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
      // 分享收紧：详情/编辑属于配置面，被分享者 403（对话链路走 /conversation 与 mention-candidates，不走此处）
      if (!canManageAgent(a, actor)) return this.json(res, { error: "forbidden" }, 403);
      if (req.method === "GET") {
        const editable = canManageAgent(a, actor);
        return this.json(res, { ...this.agentToDTO(a, editable), editable });
      }
      if (req.method === "PATCH") {
        if (!canManageAgent(a, actor)) return this.json(res, { error: "forbidden" }, 403);
        const patch = JSON.parse(await this.readBody(req)) as Partial<Agent>;
        // 扩展目录写严格预检：仅相对路径（merged 走容忍 parseAgent，存量脏行不阻断无关字段编辑）
        if (patch.extensionDirectories !== undefined) {
          AgentExtensionDirectoriesInputSchema.parse(patch.extensionDirectories);
        }
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
        await this.agentCallbackStore?.revoke(id);
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
      // 平台进化官：内置且仅管理员可用（会话建立与消息入口双重校验）
      if (id === BUILTIN_SELF_IMPROVER_AGENT_ID) {
        const meUser = await this.deps.userStore?.get(me);
        if (meUser?.role !== "admin") {
          return this.json(res, { error: "forbidden" }, 403);
        }
      }
      // 内置智能体：代码常量不入库，直接 get-or-create 其会话
      const builtinName =
        id === BUILTIN_ASSIST_AGENT_ID
          ? BUILTIN_ASSIST_AGENT.name
          : id === AGENT_BUILDER_ID
            ? AGENT_BUILDER_AGENT.name
            : id === BUILTIN_SKILL_FORGE_AGENT_ID
              ? BUILTIN_SKILL_FORGE_AGENT.name
              : id === BUILTIN_AUDITOR_AGENT_ID
                ? BUILTIN_AUDITOR_AGENT.name
                : id === BUILTIN_SELF_IMPROVER_AGENT_ID
                  ? buildSelfImproverAgent(this.deps.selfImproveGitRepository).name
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
    // POST /api/agents/:id/duplicate —— 复制智能体（自有∪被分享∪admin 均可）：
    // 只复制非凭证配置，凭证类一律不随复制，由复制者自行补充（specs/2026-09-20-agent-share-tighten-and-duplicate-design.md §3.4）
    const duplicateMatch = url.match(/^\/api\/agents\/([\w-]+)\/duplicate$/);
    if (duplicateMatch && req.method === "POST") {
      const sid = duplicateMatch[1] ?? "";
      const me = this.requireUserId(req);
      const src = await this.agentStore?.get(sid);
      if (!src) return this.json(res, { error: "not found" }, 404);
      const meUser = await this.deps.userStore?.get(me);
      const actor = { id: me, role: (meUser?.role ?? "user") as "admin" | "user" };
      const granted = this.agentShareStore ? await this.agentShareStore.isGranted(sid, me) : false;
      if (!canUseAgent(src, actor, granted)) return this.json(res, { error: "forbidden" }, 403);
      // admin 复制他人也按「他人」命名：以 ownerId 判定而非 canManageAgent
      const isMine = src.ownerId === me;
      const ownerUser = isMine ? undefined : await this.deps.userStore?.get(src.ownerId);
      const existingNames = new Set(
        ((await this.agentStore?.listByOwner(me)) ?? []).map((a) => a.name),
      );
      const warnings: string[] = [];
      if (src.mcpServers.some((m) => m.env || m.headers)) {
        warnings.push("MCP 凭证未随复制，请自行补充");
      }
      if (src.gitRepositories.some((r) => r.credentialCode)) {
        warnings.push("Git 仓库凭证未随复制，请重新选择凭证");
      }
      if (src.connectorIds.length > 0) warnings.push("连接器未随复制，请重新勾选");
      if (src.credentials.length > 0) warnings.push("凭证勾选未随复制，请自行补充");
      // 扩展目录已改版为相对路径（相对复制者自己的工作区根解析）；存量绝对路径条目不随复制
      const relativeDirs = src.extensionDirectories.filter((d) => isRelativeExtensionPath(d.path));
      if (relativeDirs.length < src.extensionDirectories.length) {
        warnings.push("扩展目录中的绝对路径条目未随复制，请在副本中改写为相对路径");
      }
      const duplicated = await this.agentStore?.create({
        ...src,
        ownerId: me,
        name: resolveDuplicateName(src.name, isMine, ownerUser?.name ?? "分享者", existingNames),
        mcpServers: src.mcpServers.map(({ env: _env, headers: _headers, ...rest }) => rest),
        credentials: [],
        connectorIds: [],
        gitRepositories: src.gitRepositories.map(({ credentialCode: _cc, ...rest }) => rest),
        extensionDirectories: relativeDirs,
        // 会话范围引用原主的其他智能体，复制者无权访问，清空（自有副本的引用依然有效，保留）
        conversationScope:
          src.conversationScope && !isMine
            ? { ...src.conversationScope, agentIds: [] }
            : src.conversationScope,
      });
      if (!duplicated) return this.json(res, { error: "agent store unavailable" }, 500);
      return this.json(res, { ...this.agentToDTO(duplicated, true), warnings });
    }
    // 智能体回调链接管理（鉴权 + canManageAgent；完整 URL 仅 POST 生成时返回一次）
    const cbAdminMatch = url.match(/^\/api\/agents\/([\w-]+)\/callback$/);
    if (cbAdminMatch) {
      const cid = cbAdminMatch[1] ?? "";
      const me = this.requireUserId(req);
      const a = await this.agentStore?.get(cid);
      if (!a) return this.json(res, { error: "not found" }, 404);
      const meUser = await this.deps.userStore?.get(me);
      const actor = { id: me, role: (meUser?.role ?? "user") as "admin" | "user" };
      if (!canManageAgent(a, actor)) return this.json(res, { error: "forbidden" }, 403);
      if (req.method === "GET") {
        const cb = await this.agentCallbackStore?.get(cid);
        return this.json(res, {
          configured: !!cb,
          tokenTail: cb ? cb.token.slice(-4) : null,
          expiresAt: cb?.expiresAt ?? null,
          createdAt: cb?.createdAt ?? null,
        });
      }
      if (req.method === "POST") {
        const body = JSON.parse(await this.readBody(req).catch(() => "{}")) as {
          validityDays?: number;
        };
        const days = body.validityDays;
        if (days !== undefined && days !== null && days !== 30 && days !== 180 && days !== 360) {
          return this.json(res, { error: "validityDays 仅支持 30/180/360，缺省为不过期" }, 400);
        }
        const cb = await this.agentCallbackStore?.upsert(cid, a.ownerId, days ?? undefined);
        if (!cb) return this.json(res, { error: "callback store unavailable" }, 500);
        return this.json(res, {
          token: cb.token,
          expiresAt: cb.expiresAt,
          url: `${this.oauthBaseUrl()}/api/callbacks/${cb.token}`,
        });
      }
      if (req.method === "DELETE") {
        await this.agentCallbackStore?.revoke(cid);
        return this.json(res, { ok: true });
      }
    }

    // 公开：回调链接发起对话（URL 即凭证，token 与 agent 一一绑定）
    const callbackPathname = url.split("?")[0] ?? url;
    const callbackMatch = callbackPathname.match(/^\/api\/callbacks\/([A-Za-z0-9_-]+)$/);
    if (callbackMatch && req.method === "GET") {
      await this.handleCallbackChat(req, res, callbackMatch[1] ?? "");
      return;
    }
    // 公开：凭 token 查回调会话执行结果（token 过期后仍可查已发起会话）
    const callbackResultMatch = callbackPathname.match(
      /^\/api\/callbacks\/([A-Za-z0-9_-]+)\/conversations\/([\w-]+)$/,
    );
    if (callbackResultMatch && req.method === "GET") {
      await this.handleCallbackResult(
        res,
        callbackResultMatch[1] ?? "",
        callbackResultMatch[2] ?? "",
      );
      return;
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
      const body = JSON.parse(await this.readBody(req)) as Record<string, unknown>;
      // hook 触发器缺省 path 时服务端生成不可猜随机 slug（规格 M4）：
      // 未认证触发通道（hook-registry 按 hook.path 匹配）的防扫描收敛；
      // 显式提供 path（任一层）保持向后兼容（存量 webhook 不迁移），另一层继承同值
      if (body.type === "hook") {
        const hookCfg = body.hook as Record<string, unknown> | undefined;
        const topGiven = typeof body.path === "string";
        const hookGiven = !!hookCfg && typeof hookCfg.path === "string";
        if (!topGiven && !hookGiven) {
          const generated = `/hooks/${randomBytes(8).toString("hex")}`;
          body.path = generated;
          if (hookCfg) hookCfg.path = generated;
        } else if (topGiven && hookCfg && !hookGiven) {
          hookCfg.path = body.path as string;
        } else if (!topGiven && hookCfg && hookGiven) {
          body.path = hookCfg.path as string;
        }
      }
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
      // requireOwnedLoop 兼做属主校验（副作用），返回值此处不需要
      await this.requireOwnedLoop(m[1] ?? "", uid);
      const enabled = m[2] === "enable";
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
    // ---- 用户技能仓库（配置/测试连接/手动同步；不依赖 credentialSets 装配）----
    if (basePath === "/api/skills/repo" || basePath.startsWith("/api/skills/repo/")) {
      const repoDeps = this.skillRepoDeps();
      if (!repoDeps) {
        send({ status: 404, json: { error: "技能仓库同步未装配" } });
        return true;
      }
      if (basePath === "/api/skills/repo" && req.method === "GET") {
        send(await handleGetSkillRepo(uid, {}, repoDeps));
        return true;
      }
      if (basePath === "/api/skills/repo" && req.method === "PUT") {
        send(await handlePutSkillRepo(uid, JSON.parse(await this.readBody(req)), repoDeps));
        return true;
      }
      if (basePath === "/api/skills/repo/verify" && req.method === "POST") {
        send(await handleVerifySkillRepo(uid, JSON.parse(await this.readBody(req)), repoDeps));
        return true;
      }
      if (basePath === "/api/skills/repo/sync" && req.method === "POST") {
        send(await handleSyncSkillRepo(uid, {}, repoDeps));
        return true;
      }
      send({ status: 404, json: { error: "路由不存在" } });
      return true;
    }
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
      await csets.createTemplate(code, withGitPatKeySpecs(parsed.data), uid);
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
      await csets.updateTemplate(code, withGitPatKeySpecs(parsed.data));
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
    return { packStore: skillPackStore, installer, skillRepoSync: this.deps.skillRepoSync };
  }

  /** 组装技能仓库 API 依赖；缺省返回 null（路由回 404）。 */
  private skillRepoDeps(): SkillRepoApiDeps | null {
    const { userSkillRepoStore, skillRepoSync, credentialSets } = this.deps;
    if (!userSkillRepoStore || !skillRepoSync) return null;
    return { repoStore: userSkillRepoStore, sync: skillRepoSync, credentialSets };
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
      // 任意响应路径只允许写一次：data 超限 / busboy limit / end 可能先后到达
      const respondJson = (status: number, payload: unknown) => {
        if (fileSaved || res.headersSent) return;
        fileSaved = true;
        res.writeHead(status);
        res.end(JSON.stringify(payload));
        resolve();
      };

      const bb = Busboy({
        headers: req.headers as Record<string, string>,
        limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
        // 浏览器/undici 的 FormData 把非 ASCII filename 以裸 UTF-8 写入；
        // busboy 默认按 latin1 解会产出 mojibake 落盘名（「季度报表.xlsx」→ 乱码）
        defParamCharset: "utf8",
      });

      bb.on(
        "file",
        (
          _fieldname: string,
          file: NodeJS.ReadableStream,
          info: { filename: string; encoding: string; mimeType: string },
        ) => {
          // 任意类型均接受（image/markdown 仅作前端渲染提示）；文件名经消毒落盘
          const filename = sanitizeUploadName(info.filename);
          const ext = filename.split(".").pop()?.toLowerCase();
          const isImage =
            info.mimeType?.startsWith("image/") &&
            ["jpg", "jpeg", "png", "gif", "webp"].includes(ext ?? "");
          const type = isImage ? "image" : ext === "md" ? "markdown" : "document";

          const chunks: Buffer[] = [];
          let totalSize = 0;

          file.on("data", (chunk: Buffer) => {
            totalSize += chunk.length;
            if (totalSize > MAX_ATTACHMENT_BYTES) {
              file.resume();
              respondJson(400, { error: `文件大小超过 ${MAX_ATTACHMENT_MB}MB 限制` });
              return;
            }
            chunks.push(chunk);
          });

          file.on("limit", () => {
            file.resume();
            respondJson(400, { error: `文件大小超过 ${MAX_ATTACHMENT_MB}MB 限制` });
          });

          file.on("end", () => {
            if (fileSaved) return;

            const ts = Date.now();
            const saveName = `${ts}-${filename}`;
            mkdirSync(sessionDir, { recursive: true });
            const absPath = join(sessionDir, saveName);
            writeFileSync(absPath, Buffer.concat(chunks));

            respondJson(200, {
              path: absPath,
              name: filename,
              type,
              url: `/uploads/${threadId}/${saveName}`,
            });
          });
        },
      );

      bb.on("error", () => {
        respondJson(500, { error: "文件保存失败" });
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

  // ===== 反馈模块 helpers（spec 2026-09-20-feedback-module-design §3.1/§4）=====

  /** 反馈详情/回复/附件共用的可见性判定：owner ∥ admin，否则 undefined（调用方 404 掩护存在性） */
  private async requireVisibleFeedback(
    req: HttpRequest,
    id: string,
  ): Promise<Feedback | undefined> {
    const fb = await this.deps.feedbackStore?.get(id);
    if (!fb) return undefined;
    const viewer = this.currentViewer(req);
    if (viewer.role !== "admin" && fb.userId !== viewer.id) return undefined;
    return fb;
  }

  /** <workspaceDir>/feedback/<id>/ —— 反馈附件独立目录，不复用会话附件链路 */
  private feedbackAttachmentDir(id: string): string {
    return resolve(this.workspaceDir, "feedback", id);
  }

  /**
   * 附件回读路径：文件名须为上传端点落盘的安全名（ASCII 安全字符），
   * 再做 resolve containment 双保险，防异形名拼接逃逸目录。
   */
  private resolveFeedbackAttachment(feedbackId: string, name: string): string | undefined {
    if (!/^[\w.-]+$/.test(name) || name.includes("..")) return undefined;
    const dir = this.feedbackAttachmentDir(feedbackId);
    const abs = resolve(dir, name);
    return abs === dir || abs.startsWith(dir + sep) ? abs : undefined;
  }

  /** 创建反馈时把上传草稿目录（?key=）更名为正式附件目录；无草稿/键非法时静默跳过 */
  private adoptFeedbackAttachments(draftKey: string, feedbackId: string): void {
    if (!draftKey || draftKey === feedbackId || !/^[\w-]{8,}$/.test(draftKey)) return;
    const draftDir = this.feedbackAttachmentDir(draftKey);
    if (!existsSync(draftDir)) return;
    try {
      renameSync(draftDir, this.feedbackAttachmentDir(feedbackId));
    } catch {
      // 更名失败不阻断创建：图片回读将 404，文本反馈仍完整
    }
  }

  /** 校验创建请求携带的 images：文件名数组 ≤3 项、安全字符；非法返回 undefined */
  private sanitizeFeedbackImages(raw: unknown): string[] | undefined {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > 3) return undefined;
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string" || !/^[\w.-]+$/.test(item) || item.includes("..")) {
        return undefined;
      }
      out.push(item);
    }
    return out;
  }

  /**
   * POST /api/feedback/attachments?key=<draftKey> —— 反馈截图上传。
   * 单文件 ≤2MB、扩展名+MIME 双白名单；落盘名 ASCII 安全化（守卫段校验/路径穿越双约束）。
   * 文件先落草稿目录 feedback/<key>/，POST /api/feedback 时整体更名为 feedback/<id>/。
   */
  private async handleFeedbackUpload(req: HttpRequest, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const key = url.searchParams.get("key") ?? "";
    if (!/^[\w-]{8,}$/.test(key)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "缺少或非法 key 参数" }));
      return;
    }
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.startsWith("multipart/form-data")) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "请求格式错误" }));
      return;
    }
    const dir = this.feedbackAttachmentDir(key);
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
          const { mimeType } = info;
          const ext = basename(info.filename).split(".").pop()?.toLowerCase() ?? "";
          const isImage =
            mimeType?.startsWith("image/") && ["jpg", "jpeg", "png", "gif", "webp"].includes(ext);
          if (!isImage) {
            file.resume();
            fileSaved = true;
            res.writeHead(400);
            res.end(JSON.stringify({ error: "仅支持图片（jpg/jpeg/png/gif/webp）" }));
            resolve();
            return;
          }

          const chunks: Buffer[] = [];
          let truncated = false;
          file.on("data", (chunk: Buffer) => chunks.push(chunk));
          file.on("limit", () => {
            truncated = true;
          });
          file.on("end", () => {
            if (fileSaved) return;
            fileSaved = true;
            if (truncated) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: "文件大小超过 2MB 限制" }));
              resolve();
              return;
            }
            // 时间戳+短随机保唯一；扩展名取白名单值，主体不保留用户原名
            const saveName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
            try {
              mkdirSync(dir, { recursive: true });
              writeFileSync(join(dir, saveName), Buffer.concat(chunks));
            } catch {
              res.writeHead(500);
              res.end(JSON.stringify({ error: "文件保存失败" }));
              resolve();
              return;
            }
            res.writeHead(200);
            res.end(JSON.stringify({ name: saveName }));
            resolve();
          });
        },
      );

      bb.on("error", () => {
        if (!fileSaved) {
          fileSaved = true;
          res.writeHead(400);
          res.end(JSON.stringify({ error: "上传解析失败" }));
          resolve();
        }
      });

      req.pipe(bb);
    });
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

  /**
   * 技能候选的分组视图：系统内置一组，每个启用的技能包一组（组内仅启用技能）。
   * 空组不返回；镜像同步仓库与手工安装的 pack 同等入列。
   */
  private async discoverAgentSkillGroups(userId: string): Promise<AgentSkillGroup[]> {
    const groups: AgentSkillGroup[] = [];
    const builtin = discoverSkills(this.agentMeta?.skillPaths ?? []);
    if (builtin.length > 0) {
      groups.push({ key: "builtin", label: "系统内置", kind: "system", skills: builtin });
    }
    if (this.deps.skillPackStore) {
      const packs = (await this.deps.skillPackStore.listPacks(userId)).filter((p) => p.enabled);
      packs.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      for (const pack of packs) {
        const skills = (await this.deps.skillPackStore.listSkills(userId, pack.id))
          .filter((s) => s.enabled)
          .map((s) => ({ id: `${pack.name}:${s.name}`, name: s.name, description: s.description }));
        if (skills.length === 0) continue;
        groups.push({
          key: `pack:${pack.id}`,
          label: pack.name,
          kind: "pack",
          description: pack.description,
          sourceLabel: skillPackSourceLabel(pack.source),
          skills,
        });
      }
    }
    return groups;
  }

  /** 扁平候选（groups 展开去重，内置组在前）；mention 过滤等按 id 数组消费的场景仍走这条 */
  private async discoverAgentSkills(
    userId: string,
  ): Promise<Array<{ id: string; name: string; description?: string }>> {
    const groups = await this.discoverAgentSkillGroups(userId);
    const seen = new Set<string>();
    return groups
      .flatMap((group) => group.skills)
      .filter((option) => {
        if (seen.has(option.id)) return false;
        seen.add(option.id);
        return true;
      });
  }

  /**
   * 解析消息中的 @/​/$/% 引用（发送时执行，不落库）：
   * - 文件：经 FileBrowser.resolveFilePath 换算为属主/边界/symlink 全校验的绝对路径；
   * - 技能：按该 agent 实际装配集过滤（显式 skills 或用户启用 Pack）；
   * - 连接器：须在 agent.connectorIds 内且对当前用户可见可用；
   * - 会话：属主 + 智能体范围/时间窗口校验后内联 wrapUntrusted 内容（开关未开启一律丢弃）。
   * fail-closed：任何未命中的引用直接丢弃，绝不让未校验路径进 prompt。
   */
  private async resolveMentions(
    userId: string | undefined,
    conversationId: string,
    mentions: MentionInput[],
  ): Promise<ResolvedMention[]> {
    if (mentions.length === 0) return [];
    const resolved: ResolvedMention[] = [];
    const conversation = this.deps.conversationStore
      ? await this.deps.conversationStore.get(conversationId)
      : undefined;
    const agent =
      conversation?.agentId && this.agentStore
        ? await this.agentStore.get(conversation.agentId)
        : undefined;
    const skillOptions = agent ? await this.effectiveAgentSkillOptions(agent.id, userId ?? "") : [];
    const seenConversations = new Set<string>();
    for (const m of mentions) {
      if (m.kind === "file") {
        const abs = await this.resolveMentionFile(userId, conversationId, m.id);
        if (abs) resolved.push({ kind: "file", label: m.label, path: abs });
      } else if (m.kind === "skill" && agent) {
        const hit = skillOptions.some((s) => s.id === m.id || s.name === m.label);
        if (hit) resolved.push({ kind: "skill", label: m.label, name: m.id });
      } else if (m.kind === "connector" && agent) {
        const c = (await this.deps.connectorStore?.listByIds([m.id]))?.[0];
        const visible =
          c?.enabled &&
          (c.shareScope === "global" || c.ownerId === userId) &&
          agent.connectorIds.includes(c.id);
        if (c && visible) resolved.push({ kind: "connector", label: m.label, name: c.name });
      } else if (m.kind === "conversation" && agent) {
        const items = await this.resolveConversationMentions(userId, conversationId, agent, m);
        const fresh = items.filter((it) => !seenConversations.has(it.conversationId));
        for (const it of fresh) seenConversations.add(it.conversationId);
        resolved.push(...fresh);
      }
    }
    return resolved;
  }

  /**
   * % 会话引用 → 经属主+范围校验的历史会话内容。
   * 开关未开启（含 agent 不在 store）一律丢弃；单条必须在过滤集合内（与候选/全部展开同一口径）；
   * 「全部会话」展开为逐会话条目。内容 wrapUntrusted 定界（单会话 20k 截断，总预算在 appendMentions）。
   */
  private async resolveConversationMentions(
    userId: string | undefined,
    currentConversationId: string,
    agent: Agent,
    m: MentionInput,
  ): Promise<Array<Extract<ResolvedMention, { kind: "conversation" }>>> {
    if (!userId || !this.deps.conversationStore || !this.messageStore) return [];
    const scope = effectiveConversationScope(agent, agent.id);
    if (!scope) return [];
    const all = await this.deps.conversationStore.listByUser(userId);
    const matched = filterConversationsByScope(
      all,
      scope,
      userId,
      new Date(),
      currentConversationId,
    ).filter((c) => m.id === CONVERSATION_MENTION_ALL_ID || c.id === m.id);
    const out: Array<Extract<ResolvedMention, { kind: "conversation" }>> = [];
    for (const c of matched) {
      const messages = await this.messageStore.listByConversation(c.id);
      const text = messages
        .map((msg) => `${msg.role === "user" ? "【用户】" : "【助手】"}${msg.text}`)
        .join("\n\n");
      const { wrapped } = wrapUntrusted(text, `conversation:${c.id} ${c.title}`);
      out.push({
        kind: "conversation",
        label: conversationMarkerLabel(c.title, c.updatedAt),
        conversationId: c.id,
        content: wrapped,
      });
    }
    return out;
  }

  /** @ 文件引用 → 绝对路径；id 形如 "runtime:<relPath>"（与候选端点下发的 scope 口径一致） */
  private async resolveMentionFile(
    userId: string | undefined,
    conversationId: string,
    id: string,
  ): Promise<string | undefined> {
    if (!userId || !this.fileBrowser) return undefined;
    const m = id.match(/^(runtime|extension):([\s\S]+)$/);
    if (!m) return undefined;
    try {
      return await this.fileBrowser.resolveFilePath(
        userId,
        m[1] as FileScope,
        m[2] ?? "",
        conversationId,
      );
    } catch {
      return undefined;
    }
  }

  /** 该 agent 实际装配的技能集（显式 skills 优先，否则用户启用 Pack 全集）——候选与发送校验共用 */
  private async effectiveAgentSkillOptions(
    agentId: string,
    userId: string,
  ): Promise<Array<{ id: string; name: string; description?: string }>> {
    const all = await this.discoverAgentSkills(userId);
    const agent = await this.agentStore?.get(agentId);
    if (!agent || agent.skills.length === 0) return all;
    const picked = new Set(agent.skills);
    return all.filter((s) => picked.has(s.id));
  }

  /** GET /api/agents/:id/mention-candidates 的响应体（输入框 @/​/$/% 引用候选） */
  private async mentionCandidates(
    viewerId: string,
    agent: Agent,
    query: string,
    currentConversationId?: string,
  ): Promise<{
    skills: Array<{ id: string; name: string; description?: string }>;
    connectors: Array<{ id: string; name: string; description?: string }>;
    files: Array<{ scope: "runtime"; path: string; label: string }>;
    /** 会话引用是否已在该智能体上开启（关闭=conversations 恒空，前端提示功能未开启） */
    conversationRefEnabled: boolean;
    conversations: Array<{ id: string; title: string; updatedAt: string }>;
  }> {
    const skills = await this.effectiveAgentSkillOptions(agent.id, viewerId);
    const connectors = this.deps.connectorStore
      ? await this.deps.connectorStore.listByIds(agent.connectorIds ?? [])
      : [];
    const visible = connectors.filter(
      (c) => c.enabled && (c.shareScope === "global" || c.ownerId === viewerId),
    );
    const lower = query.toLowerCase();
    const seen = new Set<string>();
    const files: Array<{ scope: "runtime"; path: string; label: string }> = [];
    if (this.deps.userStore) {
      const user = await this.deps.userStore.get(viewerId);
      if (user) {
        // 与 runtime scope 同根（agents/<id>/workspace）；引用标记以空白为界，路径含空白不可作候选
        const root = scopeRoots("runtime", {
          homeDir: resolve(user.homeDir),
          workspaceDir: this.workspaceDir,
          agentId: agent.id,
        })[0];
        if (root) {
          for (const f of flattenWorkspaceFiles(root)) {
            if (lower && !f.path.toLowerCase().includes(lower)) continue;
            if (/\s/.test(f.path) || seen.has(f.path)) continue;
            seen.add(f.path);
            files.push({ scope: "runtime", path: f.path, label: f.path });
            if (files.length >= 50) break;
          }
        }
      }
    }
    // 会话候选：开关未开启时恒空（不做查询）；开启后按范围过滤并排除当前会话自身
    const scope = effectiveConversationScope(agent, agent.id);
    let conversations: Array<{ id: string; title: string; updatedAt: string }> = [];
    if (scope && this.deps.conversationStore) {
      const all = await this.deps.conversationStore.listByUser(viewerId);
      conversations = filterConversationsByScope(
        all,
        scope,
        viewerId,
        new Date(),
        currentConversationId,
      )
        .slice(0, 50)
        .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }));
    }
    return {
      skills: skills.slice(0, 50),
      connectors: visible.map((c) => ({ id: c.id, name: c.name, description: c.description })),
      files,
      conversationRefEnabled: scope !== undefined,
      conversations,
    };
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
      defaultPermissionMode: a.defaultPermissionMode,
      version: a.version,
      conversationScope: a.conversationScope,
    };
  }

  /** 会话 DTO 附生效权限模式（存储覆盖 ?? 绑定智能体默认 ?? 系统缺省） */
  private async conversationWithMode(
    conv: Conversation,
  ): Promise<Conversation & { effectivePermissionMode: AgentPermissionMode }> {
    const agent = conv.agentId ? await this.deps.agentStore?.get(conv.agentId) : undefined;
    return {
      ...conv,
      effectivePermissionMode: resolvePermissionMode(
        conv.permissionMode,
        agent?.defaultPermissionMode,
      ),
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

  /** GitHub 登录/绑定共用的回调地址（模块配置覆盖优先于推导） */
  private githubRedirectUri(cfg: GithubModuleConfig): string {
    return cfg.redirectUriOverride?.trim() || `${this.oauthBaseUrl()}/api/auth/github/callback`;
  }

  /** 授权码 → access_token → 用户信息 */
  private async fetchGithubUser(cfg: GithubModuleConfig, code: string): Promise<GithubUserInfo> {
    const accessToken = await getGithubAccessToken(
      cfg.clientId,
      cfg.clientSecret,
      code,
      this.githubRedirectUri(cfg),
    );
    return getGithubUser(accessToken);
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
    // 内置智能体（assist/builder/skill-forge/auditor）不入库，无仓库配置，跳过 git 检查（否则 404 逃逸会打崩进程）
    if (
      conversation.agentId === BUILTIN_ASSIST_AGENT_ID ||
      conversation.agentId === AGENT_BUILDER_ID ||
      conversation.agentId === BUILTIN_SKILL_FORGE_AGENT_ID ||
      conversation.agentId === BUILTIN_AUDITOR_AGENT_ID
    ) {
      return undefined;
    }
    // 平台进化官：内置但绑定 donger 仓库；返回常量 agent 后由调用方统一做 git 就绪检查
    if (conversation.agentId === BUILTIN_SELF_IMPROVER_AGENT_ID) {
      const user = await this.deps.userStore?.get(userId);
      if (!user) return undefined;
      return { user, agent: buildSelfImproverAgent(this.deps.selfImproveGitRepository) };
    }
    const user2 = await this.deps.userStore?.get(userId);
    const agent2 = await this.deps.agentStore?.get(conversation.agentId);
    if (!user2 || !agent2) throw new NotFoundError("AGENT_NOT_FOUND", "智能体不存在");
    const granted = this.deps.agentShareStore
      ? await this.deps.agentShareStore.isGranted(agent2.id, userId)
      : false;
    if (!canUseAgent(agent2, user2, granted)) {
      throw new ForbiddenError("AGENT_FORBIDDEN", "无权使用该智能体");
    }
    return { user: user2, agent: agent2 };
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
