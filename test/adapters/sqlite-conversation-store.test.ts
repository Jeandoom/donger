import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";

let db: Database.Database;
let store: SqliteConversationStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteConversationStore(db);
  store.migrate();
});
afterEach(() => db.close());

describe("SqliteConversationStore", () => {
  it("create + get", async () => {
    const c = await store.create("u1", "web", "测试");
    expect(c.userId).toBe("u1");
    expect(c.sdkSessionId).toBe("");
    expect((await store.get(c.id))?.title).toBe("测试");
  });

  it("listByUser（排除归档，最新在前）", async () => {
    await store.create("u1", "web", "第一条");
    await new Promise((r) => setTimeout(r, 10));
    const c2 = await store.create("u1", "web", "第二条");
    const list = await store.listByUser("u1");
    expect(list.length).toBe(2);
    expect(list[0]?.id).toBe(c2.id);
  });

  it("getLatest", async () => {
    const c1 = await store.create("u1", "dingtalk", "钉钉1");
    await new Promise((r) => setTimeout(r, 10));
    const c2 = await store.create("u1", "dingtalk", "钉钉2");
    const latest = await store.getLatest("u1", "dingtalk");
    expect(latest?.id).toBe(c2.id);
  });

  it("update 回写 sdkSessionId + title", async () => {
    const c = await store.create("u1", "web", "测试");
    await store.update(c.id, { sdkSessionId: "sdk-123", title: "新标题" });
    const updated = await store.get(c.id);
    expect(updated?.sdkSessionId).toBe("sdk-123");
    expect(updated?.title).toBe("新标题");
  });

  it("update archived → listByUser 排除", async () => {
    const c = await store.create("u1", "web", "待归档");
    await store.update(c.id, { archived: true });
    expect((await store.listByUser("u1")).length).toBe(0);
  });

  it("create 默认 agentId=''；createWithAgent 指定", async () => {
    const c = await store.create("u", "web", "t");
    expect(c.agentId).toBe("");
    const c2 = await store.createWithAgent("u", "web", "t", "agentX");
    expect(c2.agentId).toBe("agentX");
    expect((await store.get(c2.id))?.agentId).toBe("agentX");
  });

  it("旧库无 agentId 列时 migrate 幂等补列", () => {
    const oldDb = new Database(":memory:");
    oldDb.exec(
      `CREATE TABLE conversations (id TEXT PRIMARY KEY, userId TEXT, sdkSessionId TEXT, title TEXT, channelId TEXT, createdAt TEXT, updatedAt TEXT, archived INTEGER)`,
    );
    const s = new SqliteConversationStore(oldDb);
    expect(() => s.migrate()).not.toThrow();
    // 补列后可正常 create
    void s.create("u", "web", "t");
    oldDb.close();
  });
});
