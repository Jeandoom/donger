import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { matchPlatformByBaseUrl } from "../domain/llm-platforms.js";
import type { UserLlmProvider } from "../domain/user-llm-provider.js";
import type {
  LlmProviderCreateInput,
  LlmProviderStore,
  LlmProviderUpdateInput,
  UserLlmProviderWithKey,
} from "../ports/llm-provider-store.js";
import type { SecretCipher } from "../util/secret-cipher.js";

interface ProviderRow {
  id: string;
  userId: string;
  name: string;
  platform: string;
  baseUrl: string;
  key: string;
  models: string;
  sdkType: string;
  isDefault: number;
  createdAt: string;
  updatedAt: string;
}

interface LegacyModelConfigRow {
  userId: string;
  url: string;
  key: string;
  models: string;
  defaultModel: string;
}

export class SqliteLlmProviderStore implements LlmProviderStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher,
  ) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_llm_providers (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        baseUrl TEXT NOT NULL,
        key TEXT NOT NULL,
        models TEXT NOT NULL,
        sdkType TEXT NOT NULL DEFAULT 'anthropic',
        isDefault INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    this.migrateLegacyModelConfigs();
  }

  /** 旧 user_model_configs 单条配置 → 一条默认 provider（全局仅当新表为空时搬迁一次，幂等）。 */
  private migrateLegacyModelConfigs(): void {
    const hasLegacy = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_model_configs'")
      .get();
    if (!hasLegacy) return;
    const existing = this.db.prepare("SELECT COUNT(*) AS n FROM user_llm_providers").get() as {
      n: number;
    };
    if (existing.n > 0) {
      this.db.exec("DROP TABLE IF EXISTS user_model_configs");
      return;
    }
    const rows = this.db
      .prepare("SELECT userId, url, key, models, defaultModel FROM user_model_configs")
      .all() as LegacyModelConfigRow[];
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO user_llm_providers
         (id, userId, name, platform, baseUrl, key, models, sdkType, isDefault, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      const platform = matchPlatformByBaseUrl(row.url);
      const legacyModels = safeParseModels(row.models);
      // defaultModel 置于首位：M1 基底解析取 models[0]，与旧 defaultModel 行为等价
      const models = [...new Set([row.defaultModel, ...legacyModels].filter(Boolean))];
      if (models.length === 0) continue;
      insert.run(
        randomUUID(),
        row.userId,
        platform ? platform.name : "迁移的自定义配置",
        platform?.id ?? "custom",
        row.url.trim().replace(/\/+$/, ""),
        this.cipher.encrypt(row.key),
        JSON.stringify(models),
        "anthropic",
        1,
        now,
        now,
      );
    }
    this.db.exec("DROP TABLE user_model_configs");
  }

  async list(userId: string): Promise<UserLlmProvider[]> {
    const rows = this.db
      .prepare("SELECT * FROM user_llm_providers WHERE userId = ? ORDER BY createdAt ASC, id ASC")
      .all(userId) as ProviderRow[];
    return rows.map((r) => this.toDomain(r));
  }

  async getWithKey(userId: string, id: string): Promise<UserLlmProviderWithKey | undefined> {
    const row = this.db
      .prepare("SELECT * FROM user_llm_providers WHERE userId = ? AND id = ?")
      .get(userId, id) as ProviderRow | undefined;
    return row ? { ...this.toDomain(row), key: this.cipher.decrypt(row.key) } : undefined;
  }

  async findDefaultWithKey(userId: string): Promise<UserLlmProviderWithKey | undefined> {
    const row = this.db
      .prepare("SELECT * FROM user_llm_providers WHERE userId = ? AND isDefault = 1 LIMIT 1")
      .get(userId) as ProviderRow | undefined;
    return row ? { ...this.toDomain(row), key: this.cipher.decrypt(row.key) } : undefined;
  }

  async create(userId: string, input: LlmProviderCreateInput): Promise<UserLlmProvider> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      if (input.isDefault) this.clearDefault(userId);
      this.db
        .prepare(
          `INSERT INTO user_llm_providers
             (id, userId, name, platform, baseUrl, key, models, sdkType, isDefault, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          userId,
          input.name,
          input.platform,
          input.baseUrl,
          this.cipher.encrypt(input.key),
          JSON.stringify(input.models),
          input.sdkType,
          input.isDefault ? 1 : 0,
          now,
          now,
        );
    });
    tx();
    const created = await this.getWithKey(userId, id);
    if (!created) throw new Error("provider 创建后读取失败");
    const { key: _key, ...provider } = created;
    return provider;
  }

  async update(
    userId: string,
    id: string,
    input: LlmProviderUpdateInput,
  ): Promise<UserLlmProvider | undefined> {
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT id FROM user_llm_providers WHERE userId = ? AND id = ?")
        .get(userId, id);
      if (!existing) return false;
      if (input.isDefault) this.clearDefault(userId);
      const sets: string[] = ["updatedAt = ?"];
      const params: unknown[] = [new Date().toISOString()];
      if (input.name !== undefined) {
        sets.push("name = ?");
        params.push(input.name);
      }
      if (input.baseUrl !== undefined) {
        sets.push("baseUrl = ?");
        params.push(input.baseUrl);
      }
      if (input.key !== undefined && input.key !== "") {
        sets.push("key = ?");
        params.push(this.cipher.encrypt(input.key));
      }
      if (input.models !== undefined) {
        sets.push("models = ?");
        params.push(JSON.stringify(input.models));
      }
      if (input.isDefault !== undefined) {
        sets.push("isDefault = ?");
        params.push(input.isDefault ? 1 : 0);
      }
      this.db
        .prepare(`UPDATE user_llm_providers SET ${sets.join(", ")} WHERE userId = ? AND id = ?`)
        .run(...params, userId, id);
      return true;
    });
    if (!tx()) return undefined;
    const row = this.db
      .prepare("SELECT * FROM user_llm_providers WHERE userId = ? AND id = ?")
      .get(userId, id) as ProviderRow | undefined;
    return row ? this.toDomain(row) : undefined;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const result = this.db
      .prepare("DELETE FROM user_llm_providers WHERE userId = ? AND id = ?")
      .run(userId, id);
    return result.changes > 0;
  }

  private clearDefault(userId: string): void {
    this.db
      .prepare("UPDATE user_llm_providers SET isDefault = 0 WHERE userId = ? AND isDefault = 1")
      .run(userId);
  }

  private toDomain(row: ProviderRow): UserLlmProvider {
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      platform: row.platform,
      baseUrl: row.baseUrl,
      models: safeParseModels(row.models),
      sdkType: row.sdkType === "openai" ? "openai" : "anthropic",
      isDefault: row.isDefault === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function safeParseModels(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}
