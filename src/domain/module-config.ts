/**
 * 模块化配置（授权/代理模块，spec 2026-09-21-auth-module-design）：
 * 钉钉 / GitHub / 邮箱 / 代理 四类配置持久化于 module_configs 表（密钥加密落库），
 * 运行时一律读 DB；.env 仅作为首启一次性自动迁移的输入（见 SqliteModuleConfigStore.migrateFromEnv）。
 */

export type ModuleKey = "dingtalk" | "github" | "email" | "proxy";

/** 钉钉配置：登录仅需 appKey+appSecret；机器人消息通道另需 robotCode */
export interface DingTalkModuleConfig {
  appKey: string;
  appSecret: string;
  robotCode?: string;
  cardTemplateId?: string;
  /** 扫码回调完整 URL 覆盖；空=按 PUBLIC_BASE_URL → host:port 推导 */
  redirectUriOverride?: string;
}

export interface GithubModuleConfig {
  clientId: string;
  clientSecret: string;
  /** 授权回调完整 URL 覆盖；空=按 PUBLIC_BASE_URL → host:port 推导 */
  redirectUriOverride?: string;
}

export interface EmailModuleConfig {
  /** 邮箱注册域名白名单（小写；空=关闭无邀请自助注册） */
  signupAllowedDomains: string[];
  /** 邮箱登录开关（false=登录页不展示邮箱表单） */
  loginEnabled: boolean;
}

export interface ProxyModuleConfig {
  /** GitHub OAuth 请求代理（如 http://127.0.0.1:7897；空=直连） */
  githubOauthProxyUrl?: string;
}

/** 首启一次性迁移的输入快照（仅非默认值；由 index.ts 从 cfg 组装） */
export interface EnvAuthSnapshot {
  dingtalk?: DingTalkModuleConfig;
  github?: GithubModuleConfig;
  email?: EmailModuleConfig;
  proxy?: ProxyModuleConfig;
}

/** 邮箱白名单解析：逗号/换行分隔，去空白、小写、去重（表单与 env 迁移共用） */
export function parseSignupDomains(raw: string | string[] | undefined): string[] {
  const parts = typeof raw === "string" ? raw.split(/[\n,]/) : (raw ?? []);
  return [...new Set(parts.map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

/** 钉钉登录可用（appKey+appSecret 齐全） */
export function dingTalkLoginReady(cfg: DingTalkModuleConfig | undefined): boolean {
  return !!cfg?.appKey?.trim() && !!cfg?.appSecret?.trim();
}

/** 钉钉机器人通道可用（登录两项 + robotCode） */
export function dingTalkRobotReady(cfg: DingTalkModuleConfig | undefined): boolean {
  return dingTalkLoginReady(cfg) && !!cfg?.robotCode?.trim();
}

/** 掩码判定用：秘密是否已设置（API 视图只回 appSecretSet，不回明文） */
export function isSecretSet(secret: string | undefined): boolean {
  return !!secret?.trim();
}
