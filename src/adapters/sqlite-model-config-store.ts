import type { Database } from "better-sqlite3";
import type { UserModelConfig } from "../domain/model-config.js";
import type { UserModelConfigStore } from "../ports/model-config-store.js";
import type { SecretCipher } from "../util/secret-cipher.js";

interface ModelConfigRow {
  userId: string;
  url: string;
  key: string;
  models: string;
  defaultModel: string;
}

export class SqliteModelConfigStore implements UserModelConfigStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher,
  ) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_model_configs (
        userId TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        key TEXT NOT NULL,
        models TEXT NOT NULL,
        defaultModel TEXT NOT NULL
      )
    `);
  }

  async get(userId: string): Promise<UserModelConfig | undefined> {
    const row = this.db
      .prepare(
        "SELECT userId, url, key, models, defaultModel FROM user_model_configs WHERE userId = ?",
      )
      .get(userId) as ModelConfigRow | undefined;
    if (!row) return undefined;
    return {
      url: row.url,
      key: this.cipher.decrypt(row.key),
      models: JSON.parse(row.models) as string[],
      defaultModel: row.defaultModel,
    };
  }

  async save(userId: string, config: UserModelConfig): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO user_model_configs (userId, url, key, models, defaultModel)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(userId) DO UPDATE SET
           url=excluded.url, key=excluded.key, models=excluded.models,
           defaultModel=excluded.defaultModel`,
      )
      .run(
        userId,
        config.url,
        this.cipher.encrypt(config.key),
        JSON.stringify(config.models),
        config.defaultModel,
      );
  }
}
