import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteTriggerQueueStore } from "../../src/adapters/sqlite-trigger-queue-store.js";

function setup() {
  const db = new Database(":memory:");
  const store = new SqliteTriggerQueueStore(db);
  store.migrate();
  return { db, store };
}

describe("SqliteTriggerQueueStore", () => {
  it("enqueue/claim FIFO：最旧 pending 先认领并转 running", async () => {
    const { store } = setup();
    await store.enqueue({ loopId: "l1", triggerId: "t", eventName: "manual", payload: "a" }, 10);
    await store.enqueue({ loopId: "l1", triggerId: "t", eventName: "manual", payload: "b" }, 10);
    const first = await store.claimNextPending("l1");
    expect(first?.payload).toBe("a");
    expect(first?.status).toBe("running");
    // running 不再被认领：下一次拿到 b
    const second = await store.claimNextPending("l1");
    expect(second?.payload).toBe("b");
    expect(await store.claimNextPending("l1")).toBeUndefined();
  });

  it("claim 按 loop 隔离", async () => {
    const { store } = setup();
    await store.enqueue({ loopId: "l1", triggerId: "t", eventName: "e", payload: "a" }, 10);
    expect(await store.claimNextPending("l2")).toBeUndefined();
    expect((await store.claimNextPending("l1"))?.payload).toBe("a");
  });

  it("上限：pending 达 max 后新事件落 dropped（留痕不执行）", async () => {
    const { store } = setup();
    const ok = await store.enqueue(
      { loopId: "l1", triggerId: "t", eventName: "e", payload: "1" },
      1,
    );
    expect(ok.status).toBe("pending");
    const over = await store.enqueue(
      { loopId: "l1", triggerId: "t", eventName: "e", payload: "2" },
      1,
    );
    expect(over.status).toBe("dropped");
    expect(over.error).toContain("overflow");
    expect(await store.countPending("l1")).toBe(1);
    // 认领后 pending 腾出：可再次入队
    await store.claimNextPending("l1");
    const again = await store.enqueue(
      { loopId: "l1", triggerId: "t", eventName: "e", payload: "3" },
      1,
    );
    expect(again.status).toBe("pending");
  });

  it("markDone 终态 + resetStaleRunning 把遗留 running 复位为 pending", async () => {
    const { store } = setup();
    await store.enqueue({ loopId: "l1", triggerId: "t", eventName: "e", payload: "a" }, 10);
    const row = await store.claimNextPending("l1");
    if (!row) throw new Error("expected claimed row");
    await store.markDone(row.id);
    expect(await store.countPending("l1")).toBe(0);
    expect(await store.listLoopIdsWithPending()).toEqual([]);
    // 模拟崩溃遗留 running
    await store.enqueue({ loopId: "l1", triggerId: "t", eventName: "e", payload: "b" }, 10);
    await store.claimNextPending("l1");
    expect(store.resetStaleRunning()).toBe(1);
    expect(await store.countPending("l1")).toBe(1);
    expect(await store.listLoopIdsWithPending()).toEqual(["l1"]);
  });

  it("deleteByLoop 级联清理 + cleanupFinishedBefore 清终态行", async () => {
    const { store } = setup();
    const r1 = await store.enqueue(
      { loopId: "l1", triggerId: "t", eventName: "e", payload: "a" },
      10,
    );
    await store.markDone(r1.id);
    await store.enqueue({ loopId: "l2", triggerId: "t", eventName: "e", payload: "b" }, 10);
    // 清理早于未来的 cutoff 不会动刚完成的行
    expect(store.cleanupFinishedBefore(new Date(Date.now() - 86_400_000).toISOString())).toBe(0);
    expect(store.cleanupFinishedBefore(new Date(Date.now() + 86_400_000).toISOString())).toBe(1);
    // pending 行不受清理影响；deleteByLoop 才清
    await store.deleteByLoop("l2");
    expect(await store.claimNextPending("l2")).toBeUndefined();
  });
});
