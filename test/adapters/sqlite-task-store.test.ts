import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteTaskStore } from "../../src/adapters/sqlite-task-store.js";

const base = {
  id: "t1",
  channelId: "cli",
  threadId: "th",
  requesterId: "u",
  prompt: "p",
  skillChain: [],
  createdAt: "t0",
  updatedAt: "t0",
};

function newStore(): SqliteTaskStore {
  const db = new Database(":memory:");
  const s = new SqliteTaskStore(db);
  s.migrate();
  return s;
}

describe("SqliteTaskStore", () => {
  it("create / get", async () => {
    const s = newStore();
    await s.create({ ...base, status: "created" });
    expect((await s.get("t1"))?.status).toBe("created");
    expect(await s.get("nope")).toBeUndefined();
  });

  it("updateStatus 改状态 + 合并 patch + 刷新 updatedAt", async () => {
    const s = newStore();
    await s.create({ ...base, status: "created" });
    await s.updateStatus("t1", "running", { cwd: "/w" });
    const t = await s.get("t1");
    expect(t?.status).toBe("running");
    expect(t?.cwd).toBe("/w");
    expect(t?.updatedAt).not.toBe("t0");
  });

  it("updateStatus 不存在抛错", async () => {
    const s = newStore();
    await expect(s.updateStatus("nope", "running")).rejects.toThrow();
  });

  it("listByStatus 过滤 + 按 updatedAt 倒序", async () => {
    const s = newStore();
    await s.create({ ...base, id: "a", status: "running", updatedAt: "2024-01-01T00:00:00Z" });
    await s.create({ ...base, id: "b", status: "done", updatedAt: "2024-01-02T00:00:00Z" });
    await s.create({ ...base, id: "c", status: "running", updatedAt: "2024-01-03T00:00:00Z" });
    const running = await s.listByStatus("running");
    expect(running.map((t) => t.id)).toEqual(["c", "a"]);
    expect((await s.listByStatus("done")).map((t) => t.id)).toEqual(["b"]);
    expect(await s.listByStatus("failed")).toEqual([]);
  });

  it("持久化：重新打开同一 DB 文件数据仍在", async () => {
    // :memory: 无法跨连接复用，用临时文件验证
    // eslint-disable-next-line
    const tmp = `${import.meta.dirname}/tmp-test.db`;
    const { rmSync } = await import("node:fs");
    try {
      rmSync(tmp, { force: true });
      const db1 = new Database(tmp);
      const s1 = new SqliteTaskStore(db1);
      s1.migrate();
      await s1.create({ ...base, id: "persist-1", status: "done" });
      db1.close();
      // 重新打开
      const db2 = new Database(tmp);
      const s2 = new SqliteTaskStore(db2);
      s2.migrate();
      expect((await s2.get("persist-1"))?.status).toBe("done");
      db2.close();
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});
