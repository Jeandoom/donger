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

  it("add 刷新所属会话的 updatedAt（会话活跃度 = 最后一条消息）", async () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        sdkSessionId TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        channelId TEXT NOT NULL DEFAULT '',
        agentId TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.prepare(
      "INSERT INTO conversations (id, userId, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
    ).run("c1", "u1", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");

    await store.add("c1", "user", "消息");
    const row = db.prepare("SELECT updatedAt FROM conversations WHERE id = 'c1'").get() as {
      updatedAt: string;
    };
    expect(row.updatedAt > "2026-09-01T00:00:00.000Z").toBe(true);
  });

  it("add 带 createdAt 回填消息时间戳，会话 updatedAt 仍刷为墙钟（zcode 对账补录，spec 2026-09-29 M2）", async () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL, sdkSessionId TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '', channelId TEXT NOT NULL DEFAULT '',
        agentId TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.prepare(
      "INSERT INTO conversations (id, userId, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
    ).run("c1", "u1", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");

    const old = "2026-09-28T07:28:46.000Z";
    await store.add("c1", "bot", "补录叙述", "[]", "task-1", { createdAt: old });
    const list = await store.listByConversation("c1");
    expect(list[0]?.createdAt).toBe(old);
    const conv = db.prepare("SELECT updatedAt FROM conversations WHERE id = 'c1'").get() as {
      updatedAt: string;
    };
    expect(conv.updatedAt).not.toBe(old);
    expect(conv.updatedAt >= old).toBe(true);
  });
});
