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
  DB_PATH: z.string().default("./data/donger.db"),
  PORT: z.coerce.number().int().positive().default(3300),
  LOG_LEVEL: LogLevelSchema.default("info"),
  SUPERPOWERS_PLUGIN_PATH: z.string().optional(),
  ADMIN_STAFF_IDS: z.string().optional(),
  DINGTALK_APP_KEY: z.string().optional(),
  DINGTALK_APP_SECRET: z.string().optional(),
  DINGTALK_ROBOT_CODE: z.string().optional(),
  DINGTALK_CARD_TEMPLATE_ID: z.string().optional(),
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
  dbPath: string;
  port: number;
  logLevel: LogLevel;
  /** superpowers 插件根目录（含 .claude-plugin/plugin.json）；缺省则不加载 */
  superpowersPluginPath?: string;
  /** 管理员 staffId 列表（ADMIN_STAFF_IDS，逗号分隔） */
  adminStaffIds: string[];
  dingtalk?: DingTalkConfig;
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
    dbPath: e.DB_PATH,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    superpowersPluginPath: e.SUPERPOWERS_PLUGIN_PATH,
    adminStaffIds: (e.ADMIN_STAFF_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
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
