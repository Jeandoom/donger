import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteWorkflowDedupStore } from "../../src/adapters/sqlite-workflow-dedup-store.js";

const WF = "wf-1";

describe("SqliteWorkflowDedupStore", () => {
  it("claim 原子认领：首次 true，同键再认领 false 并返回既有条目", async () => {
    const store = new SqliteWorkflowDedupStore(new Database(":memory:"));
    store.migrate();
    const first = await store.claim(WF, "task-1", "run-1");
    expect(first.claimed).toBe(true);
    const second = await store.claim(WF, "task-1", "run-2");
    expect(second.claimed).toBe(false);
    expect(second.existing?.runId).toBe("run-1");
    expect(second.existing?.status).toBe("claimed");
  });

  it("不同工作流/不同键互不干扰", async () => {
    const store = new SqliteWorkflowDedupStore(new Database(":memory:"));
    store.migrate();
    expect((await store.claim(WF, "k1", "r1")).claimed).toBe(true);
    expect((await store.claim("wf-2", "k1", "r2")).claimed).toBe(true);
    expect((await store.claim(WF, "k2", "r3")).claimed).toBe(true);
  });

  it("release 后可重认领；无 claimed 行时 release 返回 false", async () => {
    const store = new SqliteWorkflowDedupStore(new Database(":memory:"));
    store.migrate();
    expect(await store.release(WF, "k-x")).toBe(false);
    await store.claim(WF, "k-x", "run-1");
    expect(await store.release(WF, "k-x", "处理失败")).toBe(true);
    const entry = await store.get(WF, "k-x");
    expect(entry?.status).toBe("released");
    // 重认领覆盖 released 行
    const reclaim = await store.claim(WF, "k-x", "run-2");
    expect(reclaim.claimed).toBe(true);
    expect((await store.get(WF, "k-x"))?.status).toBe("claimed");
  });

  it("list 按 createdAt 倒序且限定工作流", async () => {
    const store = new SqliteWorkflowDedupStore(new Database(":memory:"));
    store.migrate();
    await store.claim("wf-a", "k1", "r1");
    await store.claim("wf-a", "k2", "r2");
    await store.claim("wf-b", "k3", "r3");
    const rows = await store.list("wf-a");
    expect(rows.map((r) => r.dedupKey).sort()).toEqual(["k1", "k2"]);
  });
});
