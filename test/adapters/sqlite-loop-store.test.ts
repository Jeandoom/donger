import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteLoopStore } from "../../src/adapters/sqlite-loop-store.js";

function newStore() {
  const db = new Database(":memory:");
  const ls = new SqliteLoopStore(db);
  ls.migrate();
  return { db, ls };
}

describe("SqliteLoopStore", () => {
  it("create with defaults (enabled=false, tags=[])", async () => {
    const { ls } = newStore();
    const l = await ls.create({ ownerId: "u1", name: "晨报", workflowId: "w1" });
    expect(l.enabled).toBe(false);
    expect(l.tags).toEqual([]);
  });

  it("setEnabled toggles and persists", async () => {
    const { ls } = newStore();
    const l = await ls.create({ ownerId: "u1", name: "L", workflowId: "w1" });
    const on = await ls.setEnabled(l.id, true);
    expect(on.enabled).toBe(true);
    expect((await ls.get(l.id))?.enabled).toBe(true);
  });

  it("createRun + updateRun + listRuns", async () => {
    const { ls } = newStore();
    const l = await ls.create({ ownerId: "u1", name: "L", workflowId: "w1" });
    const r = await ls.createRun({
      id: "r1",
      loopId: l.id,
      workflowId: "w1",
      triggerId: "t1",
      agentId: "a1",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    await ls.updateRun(r.id, {
      status: "success",
      finishedAt: new Date().toISOString(),
      agentConversationId: "c1",
    });
    const runs = await ls.listRuns(l.id);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("success");
  });

  it("listEnabled returns only enabled loops", async () => {
    const { ls } = newStore();
    await ls.create({ ownerId: "u1", name: "A", workflowId: "w1" });
    const b = await ls.create({ ownerId: "u1", name: "B", workflowId: "w1" });
    await ls.setEnabled(b.id, true);
    expect((await ls.listEnabled()).map((l) => l.name)).toEqual(["B"]);
  });

  it("updateRuntimeState writes lastRunId/lastError", async () => {
    const { ls } = newStore();
    const l = await ls.create({ ownerId: "u1", name: "L", workflowId: "w1" });
    await ls.updateRuntimeState(l.id, { lastRunId: "r1", lastError: null });
    expect((await ls.get(l.id))?.lastRunId).toBe("r1");
  });

  it("update changes name + tags", async () => {
    const { ls } = newStore();
    const l = await ls.create({ ownerId: "u1", name: "L", workflowId: "w1" });
    const next = await ls.update(l.id, { name: "L2", tags: ["ci", "prod"] });
    expect(next.name).toBe("L2");
    expect(next.tags).toEqual(["ci", "prod"]);
  });

  it("sweepOrphanedRuns marks running as failed", async () => {
    const { ls } = newStore();
    const l = await ls.create({ ownerId: "u1", name: "L", workflowId: "w1" });
    await ls.createRun({
      id: "r1",
      loopId: l.id,
      workflowId: "w1",
      triggerId: "t1",
      agentId: "a1",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const swept = await ls.sweepOrphanedRuns("process restart");
    expect(swept).toBe(1);
    const r = await ls.getRun("r1");
    expect(r?.status).toBe("failed");
    expect(r?.error).toBe("process restart");
    expect(r?.finishedAt).toBeTruthy();
  });
});
