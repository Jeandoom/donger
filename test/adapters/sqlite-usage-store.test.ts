import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteUsageStore } from "../../src/adapters/sqlite-usage-store.js";

let db: Database.Database;
let store: SqliteUsageStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteUsageStore(db);
  store.migrate();
});
afterEach(() => db.close());

function base(over: { taskId?: string; userId?: string } = {}) {
  return {
    taskId: over.taskId ?? "t1",
    userId: over.userId ?? "u1",
    channelId: "web",
    model: "glm-4.6",
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 2,
    cacheReadInputTokens: 1,
  };
}

describe("SqliteUsageStore", () => {
  it("record + list 往返，totalTokens 自动计算", async () => {
    const r = await store.record(base());
    expect(r.totalTokens).toBe(18);
    const list = await store.list();
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe(r.id);
    expect(list[0]?.userId).toBe("u1");
  });

  it("migrate 幂等（重复调用不报错）", () => {
    expect(() => store.migrate()).not.toThrow();
  });

  it("list 按 userId / taskId 过滤", async () => {
    await store.record(base({ userId: "u1", taskId: "t1" }));
    await store.record(base({ userId: "u2", taskId: "t2" }));
    expect((await store.list({ userId: "u1" })).length).toBe(1);
    expect((await store.list({ taskId: "t2" })).length).toBe(1);
  });

  it("list 最新在前", async () => {
    await store.record(base());
    await new Promise((r) => setTimeout(r, 10));
    const second = await store.record(base());
    expect((await store.list())[0]?.id).toBe(second.id);
  });

  it("list 默认 limit 100（插入 3 条取 2）", async () => {
    await store.record(base());
    await store.record(base());
    await store.record(base());
    expect((await store.list({ limit: 2 })).length).toBe(2);
  });
});
