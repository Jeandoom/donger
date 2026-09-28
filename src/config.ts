import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { type GitProvider, inferGitProvider } from "./domain/git.js";
import type { LLMConfig } from "./domain/llm-config.js";

/** 路径类配置统一绝对化（相对值按进程 cwd 解析）：路径会传给 SDK/CLI 子进程，
 * 子进程 cwd 与服务不同（如 agent workspace），相对路径会在那边拼错（技能插件加载失败）。 */
function toAbs(p: string): string {
  return resolve(p);
}

const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

const EnvSchema = z.object({
  ANTHROPIC_BASE_URL: z.string().min(1),
  ANTHROPIC_AUTH_TOKEN: z.string().min(1),
  LLM_MODEL: z.string().default("glm-4.6"),
  REPO_ROOT: z.string().default("./repos"),
  MEMORY_DIR: z.string().default("./data/memory"),
  WORKSPACE_DIR: z.string().default(""),
  DB_PATH: z.string().default(""),
  PORT: z.coerce.number().int().positive().default(3330),
  // 服务监听地址：0.0.0.0=全网卡（可外部访问），127.0.0.1=仅本机。
  HOST: z.string().default("0.0.0.0"),
  HTTPS_CERT_PATH: z.string().optional().default(""),
  HTTPS_KEY_PATH: z.string().optional().default(""),
  HTTPS_CHAIN_PATH: z.string().optional().default(""),
  LOG_LEVEL: LogLevelSchema.default("info"),
  // 预装技能根目录（其下每个子目录 = 一个预装 Pack）；默认 <repoRoot>/skills
  BUILTIN_SKILLS_DIR: z.string().default(""),
  // 管理员的外部 ID 白名单（逗号分隔；裸 externalId 对全平台生效，
  // 或 "provider:externalId" 限定平台（如 github:12345678）。见 domain/user.ts 的 isAdminExternalId）。
  ADMIN_EXTERNAL_IDS: z.string().optional().default(""),
  // 已废弃：保留以向后兼容，值会被合并进 ADMIN_EXTERNAL_IDS。
  ADMIN_STAFF_IDS: z.string().optional(),
  // ==== 三方授权 env（钉钉/GitHub/邮箱/代理）====
  // spec 2026-09-21-auth-module-design：以下字段仅作为首启一次性自动迁移的输入
  // （迁移进 module_configs 表后运行时一律只读 DB，改 env 不再生效）；下个大版本可删除。
  DINGTALK_APP_KEY: z.string().optional(),
  DINGTALK_APP_SECRET: z.string().optional(),
  DINGTALK_ROBOT_CODE: z.string().optional(),
  DINGTALK_CARD_TEMPLATE_ID: z.string().optional(),
  // 钉钉扫码登录回调地址（完整 URL，须与钉钉开放平台注册的重定向 URI 一致；
  // 空=按 PUBLIC_BASE_URL → HOST:PORT 推导）【仅迁移输入】
  DINGTALK_LOGIN_REDIRECT_URI: z.string().optional().default(""),
  // GitHub OAuth 登录（两值均非空才启用；OAuth App: https://github.com/settings/developers）【仅迁移输入】
  GITHUB_CLIENT_ID: z.string().optional().default(""),
  GITHUB_CLIENT_SECRET: z.string().optional().default(""),
  // GitHub 登录回调地址（完整 URL 覆盖；空=按 PUBLIC_BASE_URL 推导）【仅迁移输入】
  GITHUB_LOGIN_REDIRECT_URI: z.string().optional().default(""),
  // GitHub 请求代理（如 http://127.0.0.1:7897；仅作用于 GitHub OAuth 请求）【仅迁移输入，运行时走代理模块】
  GITHUB_OAUTH_PROXY: z.string().optional().default(""),
  // 邮箱注册域名白名单（逗号分隔；空=关闭无邀请的自助注册）【仅迁移输入，运行时走授权模块】
  EMAIL_SIGNUP_ALLOWED_DOMAINS: z.string().optional().default(""),
  // 邮箱登录开关【仅迁移输入，运行时走授权模块】
  EMAIL_LOGIN_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // 零配置引导加固（可选）：配置后首个管理员初始化（POST /api/setup/admin）须携带此 token；
  // 未配置=第一人即可初始化。首启会打印提示
  SETUP_TOKEN: z.string().optional().default(""),
  // 仅在确有反向代理/网关时开启：取 X-Forwarded-For 首段作为限流 IP。
  // false（默认）= 直连形态，取 socket.remoteAddress（防伪造头绕过限流）
  TRUST_PROXY: z.coerce.boolean().optional().default(false),
  JWT_SECRET: z.string().optional(),
  JWT_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // CLI 前端登录共享密钥（非空时启用 POST /api/auth/exchange 换 JWT；空=关闭该端点）
  CLI_TOKEN: z.string().optional().default(""),
  // Agent MCP 密钥主密钥 seed；缺省从 JWT_SECRET 派生（见 resolveSecretSeed）
  SECRET_KEY: z.string().optional(),
  // Agent 可选 LLM 预置模型，格式 name|model|baseUrl，多条用 ; 分隔
  AGENT_LLM_PRESETS: z.string().optional().default(""),
  DISPATCHER_AGENT_ID: z.string().optional(),
  BUILDER_AGENT_ID: z.string().optional(),
  CHAT_AGENT_ID: z.string().optional(),
  // 平台进化官（内置自我迭代智能体）绑定的 donger 仓库 HTTPS 地址；空=不绑仓库（仅评估/设计/审计）
  SELF_IMPROVE_GIT_URL: z.string().optional(),
  // 私有仓库凭证模板 code（须 kind=git 且 repoUrl 与上者一致；空=匿名访问）
  SELF_IMPROVE_GIT_CREDENTIAL: z.string().optional(),
  PUBLIC_BASE_URL: z.string().optional().default(""),
  GIT_CLONE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  GIT_AUTH_CACHE_TTL_MS: z.coerce.number().int().positive().default(600_000),
  // 智能体回调链接发起限流（次/分钟/token，防泄露后被刷 LLM 费用）
  CALLBACK_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),
  // LLM 流停摆看门狗：轮内超过该毫秒数无任何事件视为挂死，中断并立即收尾（0=关闭）
  TURN_STALL_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(600_000),
  // 会话空闲滚动：距会话最后活跃超过该小时数时重开新 SDK 会话（0=关闭）；
  // 防止低频闲聊会话跨天 resume 导致每轮全量重建超长上下文（实测"回复 OK"烧 32k 输入 token）
  SESSION_IDLE_ROLL_HOURS: z.coerce.number().int().nonnegative().default(168),
  /** 允许仓库地址指向内网/回环 host（本地部署缺省允许；多用户部署建议 false 防 SSRF） */
  GIT_ALLOW_PRIVATE_HOSTS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // 触发器 http source 是否允许内网目标（默认拒绝防 SSRF；内网联动场景显式开启）
  TRIGGER_ALLOW_PRIVATE_NET: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // 触发事件队列单 loop pending 上限（超出落 dropped+告警；防 DoS 显式边界）
  TRIGGER_QUEUE_MAX_PENDING: z.coerce.number().int().min(1).max(10_000).default(200),
  // app-proxy 外部服务凭证已迁出 .env（2026-09-29-app-proxy-credential-binding）：
  // 应用属主在「凭证」页自填、经 type=http 连接器绑定到应用通道；.env 不再承载任何代理凭证。
});

/** 钉钉企业自建应用配置（仅当 KEY/SECRET/ROBOT_CODE 三者齐全才出现） */
export interface DingTalkConfig {
  appKey: string;
  appSecret: string;
  robotCode: string;
  /** AI 卡片模板 ID（可选；有则用 AI 卡片流式回复） */
  cardTemplateId?: string;
}

/** GitHub OAuth 登录配置（仅当 CLIENT_ID/CLIENT_SECRET 均非空才出现） */
export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/** Agent 可选 LLM 预置模型（authToken 复用全局 ANTHROPIC_AUTH_TOKEN） */
export interface LlmPreset {
  id: string;
  name: string;
  model: string;
  baseUrl: string;
}

/** task-flow agent 链可配置项：各环节替换为用户自建 agent id（缺省系统内置常量） */
export interface AgentChainEnvConfig {
  dispatcherAgentId?: string;
  builderAgentId?: string;
  chatAgentId?: string;
}

export interface AppConfig {
  llm: LLMConfig;
  repoRoot: string;
  memoryDir: string;
  workspaceDir: string;
  dbPath: string;
  port: number;
  host: string;
  https?: {
    certPath: string;
    keyPath: string;
    chainPath?: string;
  };
  logLevel: LogLevel;
  /** 预装技能根目录（其下每个子目录 = 一个预装 Pack）；默认 <repoRoot>/skills */
  builtinSkillsDir: string;
  /** 管理员外部 ID 列表（ADMIN_EXTERNAL_IDS，逗号分隔；兼容 ADMIN_STAFF_IDS） */
  adminExternalIds: Set<string>;
  /** 钉钉配置（仅当 KEY/SECRET/ROBOT_CODE 三者齐全；迁移输入——运行时读 module_configs） */
  dingtalk?: DingTalkConfig;
  /** GitHub OAuth 配置（迁移输入——运行时读 module_configs） */
  githubOAuth?: GithubOAuthConfig;
  /** JWT 签名密钥（空字符串表示未配置，由 index.ts 处理） */
  jwtSecret: string;
  /** CLI 前端登录共享密钥（空=未启用 POST /api/auth/exchange） */
  cliToken: string;
  /** JWT 过期天数 */
  jwtTtlDays: number;
  /** Agent 密钥主密钥 seed（SECRET_KEY，缺省派生自 JWT_SECRET） */
  secretKeySeed: string;
  /** Agent 可选 LLM 预置列表 */
  agentLlmPresets: LlmPreset[];
  /** task-flow agent 链（DISPATCHER_AGENT_ID/BUILDER_AGENT_ID/CHAT_AGENT_ID，均可选） */
  agentChain: AgentChainEnvConfig;
  /** 平台进化官绑定的 donger 仓库（SELF_IMPROVE_GIT_URL 未配或非法=undefined，不绑仓库） */
  selfImproveGit?: { url: string; provider: GitProvider; credentialCode?: string };
  publicBaseUrl: string;
  /** 钉钉扫码登录回调地址（完整 URL 覆盖；空=按 publicBaseUrl → host:port 推导） */
  dingtalkLoginRedirectUri: string;
  /** GitHub 登录回调地址（完整 URL 覆盖；空=按 publicBaseUrl → host:port 推导） */
  githubLoginRedirectUri: string;
  /** GitHub 请求代理 URL（空=直连） */
  githubProxyUrl: string;
  /** 邮箱注册域名白名单（规范化为小写集合；空=关闭无邀请自助注册；迁移输入，运行时读 DB） */
  emailSignupAllowedDomains: Set<string>;
  /** 邮箱登录开关（迁移输入，运行时读 DB） */
  emailLoginEnabled: boolean;
  /** 零配置引导加固 token（可选；配置后 setup 须携带） */
  setupToken: string;
  /** 限流取 IP 是否信任 X-Forwarded-For（仅反代部署开启） */
  trustProxy: boolean;
  gitCloneTimeoutMs: number;
  gitAuthCacheTtlMs: number;
  gitAllowPrivateHosts: boolean;
  /** 触发器 http source 是否允许内网目标（TRIGGER_ALLOW_PRIVATE_NET，默认 false） */
  triggerAllowPrivateNet: boolean;
  /** 触发事件队列单 loop pending 上限（TRIGGER_QUEUE_MAX_PENDING，默认 200） */
  triggerQueueMaxPending: number;
  /** 智能体回调链接发起限流（次/分钟/token） */
  callbackRateLimitPerMin: number;
  /** LLM 流停摆看门狗阈值（毫秒；0=关闭） */
  turnStallTimeoutMs: number;
  /** 会话空闲滚动阈值（小时；0=关闭） */
  sessionIdleRollHours: number;
}

/**
 * 从环境变量加载并校验配置。
 * 接收 env 作参数以保持可测；调用方传入 process.env。
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const e = EnvSchema.parse(env);
  const https = parseHttpsConfig(e.HTTPS_CERT_PATH, e.HTTPS_KEY_PATH, e.HTTPS_CHAIN_PATH);
  const cfg: AppConfig = {
    llm: {
      model: e.LLM_MODEL,
      baseUrl: e.ANTHROPIC_BASE_URL,
      authToken: e.ANTHROPIC_AUTH_TOKEN,
    },
    repoRoot: toAbs(e.REPO_ROOT),
    memoryDir: toAbs(e.MEMORY_DIR),
    workspaceDir: toAbs(e.WORKSPACE_DIR || join(homedir(), ".donger", "workspace")),
    dbPath: toAbs(e.DB_PATH || join(homedir(), ".donger", "donger.db")),
    port: e.PORT,
    host: e.HOST,
    https,
    logLevel: e.LOG_LEVEL,
    builtinSkillsDir: toAbs(e.BUILTIN_SKILLS_DIR || join(e.REPO_ROOT, "skills")),
    adminExternalIds: parseAdminExternalIds(e.ADMIN_EXTERNAL_IDS, e.ADMIN_STAFF_IDS),
    jwtSecret: e.JWT_SECRET ?? "",
    cliToken: e.CLI_TOKEN,
    jwtTtlDays: e.JWT_TTL_DAYS,
    secretKeySeed: resolveSecretSeed(e.SECRET_KEY, e.JWT_SECRET ?? ""),
    agentLlmPresets: parseLlmPresets(e.AGENT_LLM_PRESETS),
    agentChain: {
      dispatcherAgentId: e.DISPATCHER_AGENT_ID || undefined,
      builderAgentId: e.BUILDER_AGENT_ID || undefined,
      chatAgentId: e.CHAT_AGENT_ID || undefined,
    },
    selfImproveGit: parseSelfImproveGit(e.SELF_IMPROVE_GIT_URL, e.SELF_IMPROVE_GIT_CREDENTIAL),
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ""),
    dingtalkLoginRedirectUri: e.DINGTALK_LOGIN_REDIRECT_URI.trim(),
    githubLoginRedirectUri: e.GITHUB_LOGIN_REDIRECT_URI.trim(),
    githubProxyUrl: e.GITHUB_OAUTH_PROXY.trim(),
    trustProxy: e.TRUST_PROXY,
    emailSignupAllowedDomains: new Set(
      e.EMAIL_SIGNUP_ALLOWED_DOMAINS.split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
    emailLoginEnabled: e.EMAIL_LOGIN_ENABLED,
    setupToken: e.SETUP_TOKEN.trim(),
    gitCloneTimeoutMs: e.GIT_CLONE_TIMEOUT_MS,
    gitAuthCacheTtlMs: e.GIT_AUTH_CACHE_TTL_MS,
    gitAllowPrivateHosts: e.GIT_ALLOW_PRIVATE_HOSTS,
    triggerAllowPrivateNet: e.TRIGGER_ALLOW_PRIVATE_NET,
    triggerQueueMaxPending: e.TRIGGER_QUEUE_MAX_PENDING,
    callbackRateLimitPerMin: e.CALLBACK_RATE_LIMIT_PER_MIN,
    turnStallTimeoutMs: e.TURN_STALL_TIMEOUT_MS,
    sessionIdleRollHours: e.SESSION_IDLE_ROLL_HOURS,
  };
  if (e.DINGTALK_APP_KEY && e.DINGTALK_APP_SECRET && e.DINGTALK_ROBOT_CODE) {
    cfg.dingtalk = {
      appKey: e.DINGTALK_APP_KEY,
      appSecret: e.DINGTALK_APP_SECRET,
      robotCode: e.DINGTALK_ROBOT_CODE,
      cardTemplateId: e.DINGTALK_CARD_TEMPLATE_ID || undefined,
    };
  }
  if (e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET) {
    cfg.githubOAuth = {
      clientId: e.GITHUB_CLIENT_ID,
      clientSecret: e.GITHUB_CLIENT_SECRET,
    };
  }
  return cfg;
}

function parseHttpsConfig(
  certPathValue: string,
  keyPathValue: string,
  chainPathValue: string,
): AppConfig["https"] {
  const certPath = certPathValue.trim();
  const keyPath = keyPathValue.trim();
  const chainPath = chainPathValue.trim();
  if (!certPath && !keyPath && !chainPath) return undefined;
  if (!certPath || !keyPath) {
    throw new Error("HTTPS_CERT_PATH 与 HTTPS_KEY_PATH 必须同时配置");
  }
  return {
    certPath: toAbs(certPath),
    keyPath: toAbs(keyPath),
    ...(chainPath ? { chainPath: toAbs(chainPath) } : {}),
  };
}

/**
 * 解析平台进化官绑定的 donger 仓库（SELF_IMPROVE_GIT_URL）。
 * 未配置 / 非法（无法推断方言）→ undefined（不绑仓库，进化的实现/推送环节不可用）。
 */
function parseSelfImproveGit(
  url: string | undefined,
  credentialCode: string | undefined,
): { url: string; provider: GitProvider; credentialCode?: string } | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  const provider = inferGitProvider(trimmed);
  if (!provider) return undefined;
  const code = credentialCode?.trim();
  return { url: trimmed.replace(/\/$/, ""), provider, ...(code ? { credentialCode: code } : {}) };
}

/**
 * 解析管理员外部 ID 白名单。
 * 优先 ADMIN_EXTERNAL_IDS；若仅设置了已废弃的 ADMIN_STAFF_IDS，则自动映射并告警。
 */
function parseAdminExternalIds(
  adminExternalIds: string,
  legacyAdminStaffIds: string | undefined,
): Set<string> {
  const ids = adminExternalIds
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // 向后兼容：ADMIN_STAFF_IDS 仍可生效
  if (legacyAdminStaffIds?.trim()) {
    process.emitWarning("ADMIN_STAFF_IDS 已废弃，请改用 ADMIN_EXTERNAL_IDS（值改为外部平台 ID）", {
      code: "DEPRECATED_ADMIN_STAFF_IDS",
    });
    for (const id of legacyAdminStaffIds
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      ids.push(id);
    }
  }
  return new Set(ids);
}

/**
 * 解析 Agent 密钥主密钥 seed。
 * 优先 SECRET_KEY；缺省从 JWT_SECRET 派生（并告警）；两者皆空返回空串。
 */
function resolveSecretSeed(secretKey: string | undefined, jwtSecret: string): string {
  if (secretKey?.trim()) return secretKey.trim();
  if (jwtSecret) {
    process.emitWarning("SECRET_KEY 未配置，从 JWT_SECRET 派生 agent 密钥主密钥", {
      code: "SECRET_KEY_DERIVED",
    });
    return jwtSecret;
  }
  return "";
}

/**
 * 解析 Agent LLM 预置列表：name|model|baseUrl，多条用 ; 分隔。
 * 任一条目字段缺失抛错。
 */
function parseLlmPresets(raw: string): LlmPreset[] {
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry, i) => {
      const parts = entry.split("|").map((p) => p?.trim());
      const name = parts[0];
      const model = parts[1];
      const baseUrl = parts[2];
      if (!name || !model || !baseUrl) {
        throw new Error(`AGENT_LLM_PRESETS 条目格式应为 name|model|baseUrl：${entry}`);
      }
      return { id: String(i), name, model, baseUrl };
    });
}
