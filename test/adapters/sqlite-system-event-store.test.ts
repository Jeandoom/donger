import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteSystemEventStore } from "../../src/adapters/sqlite-system-event-store.js";

let db: Database.Database;
let store: SqliteSystemEventStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteSystemEventStore(db);
  store.migrate();
});

describe("SqliteSystemEventStore", () => {
  it("record 补 id/createdAt 并持久化；list 新的在前且尊重 limit", async () => {
    const a = await store.record({
      type: "user_role_change",
      actorId: "u1",
      actorName: "甲",
      detail: "d1",
      createdAt: "2020-01-01T00:00:00.000Z", // 显式旧时间，保证排序断言稳定
    });
    expect(a.id).toBeTruthy();
    expect(a.createdAt).toBeTruthy();
    const b = await store.record({
      type: "user_role_change",
      actorId: "u2",
      actorName: "乙",
      targetUserId: "t1",
      targetUserName: "丙",
      detail: "d2",
    });

    const all = await store.list();
    expect(all.map((e) => e.detail)).toEqual(["d2", "d1"]); // 新的在前
    expect(all[0]?.targetUserName).toBe("丙");

    const one = await store.list(1);
    expect(one.length).toBe(1);
    expect(one[0]?.id).toBe(b.id);
  });

  it("空库 list 返回空数组", async () => {
    expect(await store.list()).toEqual([]);
  });
});
