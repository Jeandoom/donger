import { describe, expect, it } from "vitest";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";

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

describe("InMemoryTaskStore", () => {
  it("create / get", async () => {
    const s = new InMemoryTaskStore();
    await s.create({ ...base, status: "created" });
    expect((await s.get("t1"))?.status).toBe("created");
    expect(await s.get("nope")).toBeUndefined();
  });

  it("重复 id 抛错", async () => {
    const s = new InMemoryTaskStore();
    await s.create({ ...base, status: "created" });
    await expect(s.create({ ...base, status: "created" })).rejects.toThrow();
  });

  it("updateStatus 改状态 + 合并 patch + 刷新 updatedAt", async () => {
    const s = new InMemoryTaskStore();
    await s.create({ ...base, status: "created" });
    await s.updateStatus("t1", "running", { cwd: "/w" });
    const t = await s.get("t1");
    expect(t?.status).toBe("running");
    expect(t?.cwd).toBe("/w");
    expect(t?.updatedAt).not.toBe("t0");
  });

  it("updateStatus 不存在的 task 抛错", async () => {
    const s = new InMemoryTaskStore();
    await expect(s.updateStatus("nope", "running")).rejects.toThrow();
  });

  it("listByStatus 过滤", async () => {
    const s = new InMemoryTaskStore();
    await s.create({ ...base, id: "a", status: "running" });
    await s.create({ ...base, id: "b", status: "done" });
    await s.create({ ...base, id: "c", status: "running" });
    expect((await s.listByStatus("running")).map((t) => t.id).sort()).toEqual(["a", "c"]);
    expect((await s.listByStatus("done")).map((t) => t.id)).toEqual(["b"]);
    expect(await s.listByStatus("failed")).toEqual([]);
  });
});
