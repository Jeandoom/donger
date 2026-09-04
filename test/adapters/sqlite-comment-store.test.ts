import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteCommentStore } from "../../src/adapters/sqlite-comment-store.js";

describe("SqliteCommentStore", () => {
  it("add/listByTask：按任务存取并按时间升序", async () => {
    const db = new Database(":memory:");
    const store = new SqliteCommentStore(db);
    store.migrate();

    await store.add("t1", "u1", "第一条");
    await store.add("t2", "u1", "别的任务");
    await store.add("t1", "u2", "第二条");

    const list = await store.listByTask("t1");
    expect(list.map((c) => c.text)).toEqual(["第一条", "第二条"]);
    expect(list[0]).toMatchObject({ taskId: "t1", userId: "u1" });
    expect(list.every((c) => c.id && c.createdAt)).toBe(true);
  });

  it("listByTask 无评论返回空数组", async () => {
    const db = new Database(":memory:");
    const store = new SqliteCommentStore(db);
    store.migrate();
    expect(await store.listByTask("none")).toEqual([]);
  });
});
