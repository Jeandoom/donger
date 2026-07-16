import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteModelConfigStore } from "../../src/adapters/sqlite-model-config-store.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

describe("SqliteModelConfigStore", () => {
  it("保存并读取用户模型配置，key 加密落库", async () => {
    const db = new Database(":memory:");
    const store = new SqliteModelConfigStore(db, createSecretCipher("test-seed"));
    store.migrate();

    await store.save("u1", {
      url: "https://llm.example.com/anthropic",
      key: "secret-key",
      models: ["claude-sonnet", "claude-haiku"],
      defaultModel: "claude-sonnet",
    });

    expect(await store.get("u1")).toEqual({
      url: "https://llm.example.com/anthropic",
      key: "secret-key",
      models: ["claude-sonnet", "claude-haiku"],
      defaultModel: "claude-sonnet",
    });
    const row = db.prepare("SELECT key FROM user_model_configs WHERE userId = 'u1'").get() as {
      key: string;
    };
    expect(row.key).not.toBe("secret-key");
    db.close();
  });
});
