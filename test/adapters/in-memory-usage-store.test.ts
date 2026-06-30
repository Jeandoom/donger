import { describe, expect, it } from "vitest";
import { InMemoryUsageStore } from "../../src/adapters/in-memory-usage-store.js";

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

describe("InMemoryUsageStore", () => {
  it("record 计算 totalTokens 并写回 id/recordedAt", async () => {
    const s = new InMemoryUsageStore();
    const r = await s.record(base());
    expect(r.id).toBeTruthy();
    expect(r.recordedAt).toBeTruthy();
    expect(r.totalTokens).toBe(18);
  });

  it("list 按 userId / taskId 过滤", async () => {
    const s = new InMemoryUsageStore();
    await s.record(base({ userId: "u1", taskId: "t1" }));
    await s.record(base({ userId: "u2", taskId: "t2" }));
    expect((await s.list({ userId: "u1" })).length).toBe(1);
    expect((await s.list({ taskId: "t2" })).length).toBe(1);
  });

  it("list 最新在前 + limit", async () => {
    const s = new InMemoryUsageStore();
    await s.record(base());
    await new Promise((r) => setTimeout(r, 10));
    const second = await s.record(base());
    const list = await s.list();
    expect(list[0]?.id).toBe(second.id);
    expect((await s.list({ limit: 1 })).length).toBe(1);
  });

  it("list 按 since/until 过滤（基于已返回的 recordedAt）", async () => {
    const s = new InMemoryUsageStore();
    const r1 = await s.record(base());
    await new Promise((r) => setTimeout(r, 10));
    await s.record(base());
    expect((await s.list({ since: r1.recordedAt })).length).toBe(2);
    expect((await s.list({ until: r1.recordedAt })).length).toBe(1);
  });
});
