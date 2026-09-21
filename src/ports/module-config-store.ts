import type {
  DingTalkModuleConfig,
  EmailModuleConfig,
  EnvAuthSnapshot,
  GithubModuleConfig,
  ModuleKey,
  ProxyModuleConfig,
} from "../domain/module-config.js";

/**
 * 模块化配置端口（授权/代理模块）。
 * 实现负责秘密字段的加密落库与解密读出；解密失败视为该模块未配置（强制重录）。
 * 全部方法同步（better-sqlite3 同步驱动），热路径每请求直读无缓存。
 */
export interface ModuleConfigStore {
  getDingTalk(): DingTalkModuleConfig | undefined;
  putDingTalk(cfg: DingTalkModuleConfig): void;
  getGithub(): GithubModuleConfig | undefined;
  putGithub(cfg: GithubModuleConfig): void;
  getEmail(): EmailModuleConfig | undefined;
  putEmail(cfg: EmailModuleConfig): void;
  getProxy(): ProxyModuleConfig | undefined;
  putProxy(cfg: ProxyModuleConfig): void;
  /** 删除模块配置（授权页「清空保存=停用」语义） */
  deleteModule(module: ModuleKey): void;
  /** app_config 标记位读取（setup_completed / auth_env_migrated 等） */
  getFlag(key: string): string | undefined;
  setFlag(key: string, value: string): void;
  /** 首启一次性迁移：快照写入 + auth_env_migrated 标记，同一事务；已有标记则 no-op */
  migrateFromEnv(snapshot: EnvAuthSnapshot): void;
  /** 便于诊断/测试的原始读取 */
  rawModule(module: ModuleKey): Record<string, unknown> | undefined;
}
