import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { LLMConfig } from "./domain/llm-config.js";

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
  // 管理员的外部 ID 白名单（钉钉 userId/staffId，逗号分隔）。
  ADMIN_EXTERNAL_IDS: z.string().optional().default(""),
  // 已废弃：保留以向后兼容，值会被合并进 ADMIN_EXTERNAL_IDS。
  ADMIN_STAFF_IDS: z.string().optional(),
  DINGTALK_APP_KEY: z.string().optional(),
  DINGTALK_APP_SECRET: z.string().optional(),
  DINGTALK_ROBOT_CODE: z.string().optional(),
  DINGTALK_CARD_TEMPLATE_ID: z.string().optional(),
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
  PUBLIC_BASE_URL: z.string().optional().default(""),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITEE_CLIENT_ID: z.string().optional(),
  GITEE_CLIENT_SECRET: z.string().optional(),
  JIHULAB_CLIENT_ID: z.string().optional(),
  JIHULAB_CLIENT_SECRET: z.string().optional(),
  GIT_CLONE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  GIT_AUTH_CACHE_TTL_MS: z.coerce.number().int().positive().default(600_000),
  /** 允许仓库地址指向内网/回环 host（本地部署缺省允许；多用户部署建议 false 防 SSRF） */
  GIT_ALLOW_PRIVATE_HOSTS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

/** 钉钉企业自建应用配置（仅当 KEY/SECRET/ROBOT_CODE 三者齐全才出现） */
export interface DingTalkConfig {
  appKey: string;
  appSecret: string;
  robotCode: string;
  /** AI 卡片模板 ID（可选；有则用 AI 卡片流式回复） */
  cardTemplateId?: string;
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
  dingtalk?: DingTalkConfig;
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
  publicBaseUrl: string;
  gitOAuth: Record<"github" | "gitee" | "jihulab", { clientId?: string; clientSecret?: string }>;
  gitCloneTimeoutMs: number;
  gitAuthCacheTtlMs: number;
  gitAllowPrivateHosts: boolean;
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
    repoRoot: e.REPO_ROOT,
    memoryDir: e.MEMORY_DIR,
    workspaceDir: e.WORKSPACE_DIR || join(homedir(), ".donger", "workspace"),
    dbPath: e.DB_PATH || join(homedir(), ".donger", "donger.db"),
    port: e.PORT,
    host: e.HOST,
    https,
    logLevel: e.LOG_LEVEL,
    builtinSkillsDir: e.BUILTIN_SKILLS_DIR || join(e.REPO_ROOT, "skills"),
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
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ""),
    gitOAuth: {
      github: { clientId: e.GITHUB_CLIENT_ID, clientSecret: e.GITHUB_CLIENT_SECRET },
      gitee: { clientId: e.GITEE_CLIENT_ID, clientSecret: e.GITEE_CLIENT_SECRET },
      jihulab: { clientId: e.JIHULAB_CLIENT_ID, clientSecret: e.JIHULAB_CLIENT_SECRET },
    },
    gitCloneTimeoutMs: e.GIT_CLONE_TIMEOUT_MS,
    gitAuthCacheTtlMs: e.GIT_AUTH_CACHE_TTL_MS,
    gitAllowPrivateHosts: e.GIT_ALLOW_PRIVATE_HOSTS,
  };
  if (e.DINGTALK_APP_KEY && e.DINGTALK_APP_SECRET && e.DINGTALK_ROBOT_CODE) {
    cfg.dingtalk = {
      appKey: e.DINGTALK_APP_KEY,
      appSecret: e.DINGTALK_APP_SECRET,
      robotCode: e.DINGTALK_ROBOT_CODE,
      cardTemplateId: e.DINGTALK_CARD_TEMPLATE_ID || undefined,
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
  return { certPath, keyPath, ...(chainPath ? { chainPath } : {}) };
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
