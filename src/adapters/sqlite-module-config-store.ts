import type { Database } from "better-sqlite3";
import type {
  DingTalkModuleConfig,
  EmailModuleConfig,
  EnvAuthSnapshot,
  GithubModuleConfig,
  ModuleKey,
  ProxyModuleConfig,
} from "../domain/module-config.js";
import type { ModuleConfigStore } from "../ports/module-config-store.js";
import { decryptValue, encryptValue } from "../util/skill-crypto.js";

interface StoredRow {
  module: string;
  config: string;
}

/**
 * module_configs 表持久化（spec 2026-09-21-auth-module-design §3.1）。
 * 秘密字段（appSecret/clientSecret）AES-256-GCM 加密后存 JSON（keyHex=app_config.module_config_secret_key）。
 */
export class SqliteModuleConfigStore implements ModuleConfigStore {
  constructor(
    private readonly db: Database,
    private readonly keyHex: string,
  ) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS module_configs (
        module    TEXT PRIMARY KEY,
        config    TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    this.ensureAppConfigTable();
  }

  private ensureAppConfigTable(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }

  // ---- 通用读写 ----

  private read(module: ModuleKey): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT config FROM module_configs WHERE module = ?").get(module) as
      | StoredRow
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.config) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  private write(module: ModuleKey, config: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO module_configs (module, config, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(module) DO UPDATE SET config = excluded.config, updatedAt = excluded.updatedAt`,
      )
      .run(module, JSON.stringify(config), new Date().toISOString());
  }

  /** 解密秘密字段；密文损坏（如换库丢 key）按未配置处理并告警，强制重录 */
  private decryptSecret(value: unknown): string | undefined {
    if (typeof value !== "string" || !value) return undefined;
    try {
      return decryptValue(this.keyHex, value);
    } catch {
      console.warn(`[module-config] 秘密字段解密失败，请重新录入配置`);
      return undefined;
    }
  }

  rawModule(module: ModuleKey): Record<string, unknown> | undefined {
    return this.read(module);
  }

  // ---- 各模块 ----

  getDingTalk(): DingTalkModuleConfig | undefined {
    const raw = this.read("dingtalk");
    if (!raw) return undefined;
    const appKey = typeof raw.appKey === "string" ? raw.appKey : "";
    const appSecret = this.decryptSecret(raw.appSecret);
    if (!appKey || !appSecret) return undefined;
    return {
      appKey,
      appSecret,
      robotCode: typeof raw.robotCode === "string" && raw.robotCode ? raw.robotCode : undefined,
      cardTemplateId:
        typeof raw.cardTemplateId === "string" && raw.cardTemplateId
          ? raw.cardTemplateId
          : undefined,
      redirectUriOverride:
        typeof raw.redirectUriOverride === "string" && raw.redirectUriOverride
          ? raw.redirectUriOverride
          : undefined,
    };
  }

  putDingTalk(cfg: DingTalkModuleConfig): void {
    this.write("dingtalk", {
      appKey: cfg.appKey,
      appSecret: encryptValue(this.keyHex, cfg.appSecret),
      ...(cfg.robotCode ? { robotCode: cfg.robotCode } : {}),
      ...(cfg.cardTemplateId ? { cardTemplateId: cfg.cardTemplateId } : {}),
      ...(cfg.redirectUriOverride ? { redirectUriOverride: cfg.redirectUriOverride } : {}),
    });
  }

  getGithub(): GithubModuleConfig | undefined {
    const raw = this.read("github");
    if (!raw) return undefined;
    const clientId = typeof raw.clientId === "string" ? raw.clientId : "";
    const clientSecret = this.decryptSecret(raw.clientSecret);
    if (!clientId || !clientSecret) return undefined;
    return {
      clientId,
      clientSecret,
      redirectUriOverride:
        typeof raw.redirectUriOverride === "string" && raw.redirectUriOverride
          ? raw.redirectUriOverride
          : undefined,
    };
  }

  putGithub(cfg: GithubModuleConfig): void {
    this.write("github", {
      clientId: cfg.clientId,
      clientSecret: encryptValue(this.keyHex, cfg.clientSecret),
      ...(cfg.redirectUriOverride ? { redirectUriOverride: cfg.redirectUriOverride } : {}),
    });
  }

  getEmail(): EmailModuleConfig | undefined {
    const raw = this.read("email");
    if (!raw) return undefined;
    return {
      signupAllowedDomains: Array.isArray(raw.signupAllowedDomains)
        ? (raw.signupAllowedDomains as unknown[]).filter(
            (d): d is string => typeof d === "string" && !!d.trim(),
          )
        : [],
      loginEnabled: raw.loginEnabled !== false,
    };
  }

  putEmail(cfg: EmailModuleConfig): void {
    this.write("email", {
      signupAllowedDomains: cfg.signupAllowedDomains,
      loginEnabled: cfg.loginEnabled,
    });
  }

  getProxy(): ProxyModuleConfig | undefined {
    const raw = this.read("proxy");
    if (!raw) return undefined;
    return {
      githubOauthProxyUrl:
        typeof raw.githubOauthProxyUrl === "string" && raw.githubOauthProxyUrl
          ? raw.githubOauthProxyUrl
          : undefined,
    };
  }

  putProxy(cfg: ProxyModuleConfig): void {
    this.write("proxy", {
      ...(cfg.githubOauthProxyUrl ? { githubOauthProxyUrl: cfg.githubOauthProxyUrl } : {}),
    });
  }

  deleteModule(module: ModuleKey): void {
    this.db.prepare("DELETE FROM module_configs WHERE module = ?").run(module);
  }

  // ---- 标记位（app_config） ----

  getFlag(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM app_config WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setFlag(key: string, value: string): void {
    this.ensureAppConfigTable();
    this.db
      .prepare(
        "INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  // ---- 首启一次性迁移（spec §2.1） ----

  migrateFromEnv(snapshot: EnvAuthSnapshot): void {
    this.ensureAppConfigTable();
    const run = this.db.transaction(() => {
      if (this.getFlag("auth_env_migrated")) return;
      if (snapshot.dingtalk) this.putDingTalk(snapshot.dingtalk);
      if (snapshot.github) this.putGithub(snapshot.github);
      if (snapshot.email) this.putEmail(snapshot.email);
      if (snapshot.proxy) this.putProxy(snapshot.proxy);
      this.setFlag("auth_env_migrated", new Date().toISOString());
    });
    run();
  }
}
