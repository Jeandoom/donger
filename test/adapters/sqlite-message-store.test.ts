import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteMessageStore } from "../../src/adapters/sqlite-message-store.js";

let db: Database.Database;
let store: SqliteMessageStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteMessageStore(db);
  store.migrate();
});
afterEach(() => db.close());

describe("SqliteMessageStore", () => {
  it("add/listByConversation 往返", async () => {
    await store.add("c1", "user", "你好");
    await store.add("c1", "bot", "回复", "[]", "task-1");
    const list = await store.listByConversation("c1");
    expect(list.length).toBe(2);
    expect(list[0]?.taskId).toBeUndefined();
    expect(list[1]?.taskId).toBe("task-1");
  });

  it("旧库（无 taskId 列）迁移后可读", () => {
    // 模拟旧 schema：建表后手动删列不可行，直接建旧结构表验证 ALTER 补列路径
    db.exec("DROP TABLE messages");
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        files TEXT NOT NULL DEFAULT '[]',
        createdAt TEXT NOT NULL
      )
    `);
    store.migrate();
    const cols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "taskId")).toBe(true);
  });
});
