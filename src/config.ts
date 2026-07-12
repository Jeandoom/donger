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
  PORT: z.coerce.number().int().positive().default(3300),
  // 服务监听地址：0.0.0.0=全网卡（可外部访问），127.0.0.1=仅本机。
  HOST: z.string().default("0.0.0.0"),
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
});

/** 钉钉企业自建应用配置（仅当 KEY/SECRET/ROBOT_CODE 三者齐全才出现） */
export interface DingTalkConfig {
  appKey: string;
  appSecret: string;
  robotCode: string;
  /** AI 卡片模板 ID（可选；有则用 AI 卡片流式回复） */
  cardTemplateId?: string;
}

export interface AppConfig {
  llm: LLMConfig;
  repoRoot: string;
  memoryDir: string;
  workspaceDir: string;
  dbPath: string;
  port: number;
  host: string;
  logLevel: LogLevel;
  /** 预装技能根目录（其下每个子目录 = 一个预装 Pack）；默认 <repoRoot>/skills */
  builtinSkillsDir: string;
  /** 管理员外部 ID 列表（ADMIN_EXTERNAL_IDS，逗号分隔；兼容 ADMIN_STAFF_IDS） */
  adminExternalIds: Set<string>;
  dingtalk?: DingTalkConfig;
  /** JWT 签名密钥（空字符串表示未配置，由 index.ts 处理） */
  jwtSecret: string;
  /** JWT 过期天数 */
  jwtTtlDays: number;
}

/**
 * 从环境变量加载并校验配置。
 * 接收 env 作参数以保持可测；调用方传入 process.env。
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const e = EnvSchema.parse(env);
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
    logLevel: e.LOG_LEVEL,
    builtinSkillsDir: e.BUILTIN_SKILLS_DIR || join(e.REPO_ROOT, "skills"),
    adminExternalIds: parseAdminExternalIds(e.ADMIN_EXTERNAL_IDS, e.ADMIN_STAFF_IDS),
    jwtSecret: e.JWT_SECRET ?? "",
    jwtTtlDays: e.JWT_TTL_DAYS,
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
  if (legacyAdminStaffIds && legacyAdminStaffIds.trim()) {
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
