import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteLlmProviderStore } from "../../src/adapters/sqlite-llm-provider-store.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function newStore(): { store: SqliteLlmProviderStore; db: Database.Database } {
  db = new Database(":memory:");
  const store = new SqliteLlmProviderStore(db, createSecretCipher("test-seed"));
  store.migrate();
  return { store, db };
}

const BASE_INPUT = {
  name: "我的智谱",
  platform: "zhipu-cn",
  baseUrl: "https://open.bigmodel.cn/api/anthropic",
  key: "sk-1",
  models: ["glm-4.6", "glm-4.5"],
  sdkType: "anthropic" as const,
  isDefault: false,
};

describe("SqliteLlmProviderStore", () => {
  it("create/list：key 密文落库、域对象不含 key", async () => {
    const { store, db } = newStore();
    const created = await store.create("u1", BASE_INPUT);
    expect(created.platform).toBe("zhipu-cn");
    expect(created.models).toEqual(["glm-4.6", "glm-4.5"]);

    const row = db.prepare("SELECT key FROM user_llm_providers WHERE id = ?").get(created.id) as {
      key: string;
    };
    expect(row.key).not.toContain("sk-1");
    expect(row.key.startsWith("v1:")).toBe(true);

    const list = await store.list("u1");
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("key");

    const withKey = await store.getWithKey("u1", created.id);
    expect(withKey?.key).toBe("sk-1");
  });

  it("用户隔离：list/getWithKey 不跨用户", async () => {
    const { store } = newStore();
    const created = await store.create("u1", BASE_INPUT);
    expect(await store.list("u2")).toHaveLength(0);
    expect(await store.getWithKey("u2", created.id)).toBeUndefined();
  });

  it("isDefault 唯一：设默认清其它", async () => {
    const { store } = newStore();
    const first = await store.create("u1", { ...BASE_INPUT, isDefault: true });
    const second = await store.create("u1", {
      ...BASE_INPUT,
      name: "第二配置",
      key: "sk-2",
      isDefault: true,
    });
    expect((await store.getWithKey("u1", first.id))?.isDefault).toBe(false);
    expect((await store.getWithKey("u1", second.id))?.isDefault).toBe(true);
    expect((await store.findDefaultWithKey("u1"))?.id).toBe(second.id);

    await store.update("u1", first.id, { isDefault: true });
    expect((await store.findDefaultWithKey("u1"))?.id).toBe(first.id);
  });

  it("update：key 留空保持原值、传值则换 key", async () => {
    const { store } = newStore();
    const created = await store.create("u1", BASE_INPUT);
    await store.update("u1", created.id, { name: "改名", models: ["glm-4.5"] });
    let current = await store.getWithKey("u1", created.id);
    expect(current?.name).toBe("改名");
    expect(current?.key).toBe("sk-1");
    expect(current?.models).toEqual(["glm-4.5"]);

    await store.update("u1", created.id, { key: "sk-3" });
    current = await store.getWithKey("u1", created.id);
    expect(current?.key).toBe("sk-3");
  });

  it("remove：删除不存在的返回 false", async () => {
    const { store } = newStore();
    const created = await store.create("u1", BASE_INPUT);
    expect(await store.remove("u1", created.id)).toBe(true);
    expect(await store.remove("u1", created.id)).toBe(false);
    expect(await store.list("u1")).toHaveLength(0);
  });

  it("旧 user_model_configs 单条迁移为默认 provider（defaultModel 置首）并 DROP 旧表", async () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE user_model_configs (
        userId TEXT PRIMARY KEY, url TEXT NOT NULL, key TEXT NOT NULL,
        models TEXT NOT NULL, defaultModel TEXT NOT NULL
      )
    `);
    db.prepare("INSERT INTO user_model_configs VALUES (?, ?, ?, ?, ?)").run(
      "legacy-u1",
      "https://open.bigmodel.cn/api/anthropic/",
      "legacy-key",
      JSON.stringify(["glm-4.5", "glm-4.6"]),
      "glm-4.6",
    );
    const store = new SqliteLlmProviderStore(db, createSecretCipher("test-seed"));
    store.migrate();

    const legacyTable = db
      .prepare("SELECT name FROM sqlite_master WHERE name='user_model_configs'")
      .get();
    expect(legacyTable).toBeUndefined();

    const migrated = await store.findDefaultWithKey("legacy-u1");
    expect(migrated).toMatchObject({
      platform: "zhipu-cn",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      key: "legacy-key",
      models: ["glm-4.6", "glm-4.5"],
      isDefault: true,
    });
  });

  it("迁移幂等：新表已有数据时旧表直接退役不重搬", async () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE user_model_configs (
        userId TEXT PRIMARY KEY, url TEXT NOT NULL, key TEXT NOT NULL,
        models TEXT NOT NULL, defaultModel TEXT NOT NULL
      )
    `);
    db.prepare("INSERT INTO user_model_configs VALUES (?, ?, ?, ?, ?)").run(
      "legacy-u1",
      "https://api.deepseek.com/anthropic",
      "k",
      '["deepseek-chat"]',
      "deepseek-chat",
    );
    const store = new SqliteLlmProviderStore(db, createSecretCipher("test-seed"));
    store.migrate();
    await store.create("u2", BASE_INPUT);
    // 二次 migrate（新表有数据）：不搬 legacy、旧表已被 DROP
    store.migrate();
    expect(await store.list("legacy-u1")).toHaveLength(1);
    expect(await store.list("u2")).toHaveLength(1);
  });

  it("toDomain：zcode sdkType 读回保留（引擎路由与徽标同源）；未知值兜底 anthropic", async () => {
    const { store, db } = newStore();
    const created = await store.create("u1", {
      ...BASE_INPUT,
      platform: "zhipu-zcode",
      sdkType: "zcode",
      isDefault: true,
    });
    expect((await store.getWithKey("u1", created.id))?.sdkType).toBe("zcode");
    expect((await store.list("u1"))[0]?.sdkType).toBe("zcode");
    expect((await store.findDefaultWithKey("u1"))?.sdkType).toBe("zcode");

    db.prepare("UPDATE user_llm_providers SET sdkType = ? WHERE id = ?").run("weird", created.id);
    expect((await store.getWithKey("u1", created.id))?.sdkType).toBe("anthropic");
  });
});
