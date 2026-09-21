import type { Database } from "better-sqlite3";
import { SqliteModuleConfigStore } from "../../src/adapters/sqlite-module-config-store.js";
import type { EmailModuleConfig } from "../../src/domain/module-config.js";

/** 测试用固定加密 key（64 位 hex = 32 字节，skill-crypto AES-256 要求） */
export const TEST_MODULE_KEY_HEX = "a".repeat(64);

/** 在测试 DB 上建 module_configs store（已 migrate），可选预置邮箱模块配置 */
export function createTestModuleConfigStore(
  db: Database,
  email?: Partial<EmailModuleConfig>,
): SqliteModuleConfigStore {
  const store = new SqliteModuleConfigStore(db, TEST_MODULE_KEY_HEX);
  store.migrate();
  if (email) {
    store.putEmail({
      signupAllowedDomains: email.signupAllowedDomains ?? [],
      loginEnabled: email.loginEnabled ?? true,
    });
  }
  return store;
}
