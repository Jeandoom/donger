import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteWorkflowRunStore } from "../../src/adapters/sqlite-workflow-run-store.js";
import type { WorkflowRun } from "../../src/domain/workflow-run.js";

function baseRun(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: crypto.randomUUID(),
    workflowId: "w1",
    eventId: "e1",
    firingId: null,
    eventName: "schedule",
    status: "queued",
    context: '{"k":1}',
    queuedAt: new Date().toISOString(),
    ...over,
  };
}

describe("SqliteWorkflowRunStore", () => {
  let db: Database.Database;
  let rs: SqliteWorkflowRunStore;

  beforeEach(() => {
    db = new Database(":memory:");
    rs = new SqliteWorkflowRunStore(db);
    rs.migrate();
  });

  it("insert + getRun + listRuns（倒序/状态过滤/游标）", async () => {
    for (const [i, status] of ["success", "failed", "queued"].entries()) {
      await rs.insert(
        baseRun({
          id: `r${i}`,
          status: status as WorkflowRun["status"],
          queuedAt: new Date(Date.parse("2026-10-09T00:00:00Z") + i * 1000).toISOString(),
        }),
      );
    }
    const all = await rs.listRuns("w1");
    expect(all.map((r) => r.id)).toEqual(["r2", "r1", "r0"]);
    const failed = await rs.listRuns("w1", { status: "failed" });
    expect(failed.map((r) => r.id)).toEqual(["r1"]);
    const before = await rs.listRuns("w1", { before: all[0]!.queuedAt });
    expect(before.map((r) => r.id)).toEqual(["r1", "r0"]);
  });

  it("countQueued 只数全局 queued 行", async () => {
    await rs.insert(baseRun({ id: "r1", status: "queued" }));
    await rs.insert(baseRun({ id: "r2", status: "queued", workflowId: "w2" }));
    await rs.insert(baseRun({ id: "r3", status: "failed" }));
    expect(await rs.countQueued()).toBe(2);
  });

  it("claimNextRunnable：同 workflow 串行、跨 workflow 并行、FIFO", async () => {
    await rs.insert(baseRun({ id: "r1", workflowId: "w1", queuedAt: "2026-10-09T00:00:01Z" }));
    await rs.insert(baseRun({ id: "r2", workflowId: "w1", queuedAt: "2026-10-09T00:00:02Z" }));
    await rs.insert(baseRun({ id: "r3", workflowId: "w2", queuedAt: "2026-10-09T00:00:03Z" }));

    const first = await rs.claimNextRunnable();
    expect(first?.id).toBe("r1");
    expect(first?.status).toBe("running");
    // w1 已有 running → 跳到 w2
    const second = await rs.claimNextRunnable();
    expect(second?.id).toBe("r3");
    // w1/w2 都有 running → w1 剩余 queued 不可认领
    expect(await rs.claimNextRunnable()).toBeUndefined();

    await rs.updateRun("r1", { status: "success", finishedAt: new Date().toISOString() });
    const third = await rs.claimNextRunnable();
    expect(third?.id).toBe("r2");
  });

  it("resetStaleRunning 把 running 重置为 queued（重启恢复）", async () => {
    const r = await rs.insert(baseRun({ id: "r1", status: "running", startedAt: "x" }));
    expect(await rs.resetStaleRunning()).toBe(1);
    const loaded = await rs.getRun(r.id);
    expect(loaded?.status).toBe("queued");
    expect(loaded?.startedAt ?? null).toBeNull();
  });

  it("listByFiring + deleteByWorkflow + stats 真聚合", async () => {
    await rs.insert(baseRun({ id: "r1", firingId: "f1" }));
    await rs.insert(baseRun({ id: "r2", firingId: "f1", workflowId: "w2" }));
    await rs.insert(
      baseRun({
        id: "r3",
        status: "success",
        startedAt: "2026-10-09T00:00:00Z",
        finishedAt: "2026-10-09T00:00:02Z",
      }),
    );
    expect((await rs.listByFiring("f1")).map((r) => r.id)).toEqual(["r1", "r2"]);

    const stats = await rs.stats("w1");
    expect(stats.total).toBe(2); // r2 属 w2，不计入
    expect(stats.success).toBe(1);
    expect(stats.failed).toBe(0);
    expect(stats.avgDurationMs).toBe(2000);

    await rs.deleteByWorkflow("w2");
    expect(await rs.getRun("r2")).toBeUndefined();
  });

  it("存量库迁移：loop_runs 搬运（running→failed）+ trigger_queue pending→queued + 旧表收尾 DROP", async () => {
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE loops (id TEXT PRIMARY KEY, workflowId TEXT NOT NULL);
      CREATE TABLE loop_runs (
        id TEXT PRIMARY KEY, loopId TEXT NOT NULL, workflowId TEXT NOT NULL,
        triggerId TEXT, agentId TEXT, status TEXT NOT NULL,
        triggerOutput TEXT, renderedPrompt TEXT, agentConversationId TEXT,
        loopDir TEXT, error TEXT, startedAt TEXT, finishedAt TEXT
      );
      CREATE TABLE trigger_queue (
        id TEXT PRIMARY KEY, loopId TEXT NOT NULL, triggerId TEXT, eventName TEXT,
        payload TEXT, status TEXT NOT NULL, error TEXT,
        createdAt TEXT NOT NULL, startedAt TEXT, finishedAt TEXT
      );
    `);
    legacy.prepare("INSERT INTO loops (id, workflowId) VALUES (?,?)").run("l1", "w1");
    const insRun = legacy.prepare(
      "INSERT INTO loop_runs (id, loopId, workflowId, triggerId, agentId, status, triggerOutput, renderedPrompt, agentConversationId, loopDir, error, startedAt, finishedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    insRun.run(
      "r-old",
      "l1",
      "w1",
      "t1",
      "a1",
      "success",
      "ctx",
      "p",
      "c1",
      "dir",
      null,
      "2026-09-01T00:00:00Z",
      "2026-09-01T00:00:05Z",
    );
    insRun.run(
      "r-orphan",
      "l1",
      "w1",
      "t1",
      "a1",
      "running",
      "ctx",
      null,
      null,
      "dir",
      null,
      "2026-09-02T00:00:00Z",
      null,
    );
    const insQ = legacy.prepare(
      "INSERT INTO trigger_queue (id, loopId, triggerId, eventName, payload, status, createdAt) VALUES (?,?,?,?,?,?,?)",
    );
    insQ.run("q1", "l1", "t1", "manual", "pending-payload", "pending", "2026-09-03T00:00:00Z");
    insQ.run("q2", "l1", "t1", "manual", "done-payload", "done", "2026-09-04T00:00:00Z");

    const store = new SqliteWorkflowRunStore(legacy);
    store.migrate();

    const migrated = await store.getRun("r-old");
    expect(migrated?.status).toBe("success");
    expect(migrated?.eventId).toBe("t1");
    expect(migrated?.conversationId).toBe("c1");
    const orphan = await store.getRun("r-orphan");
    expect(orphan?.status).toBe("failed");
    expect(orphan?.error).toContain("迁移");
    // pending 队列行→queued 执行记录（at-least-once）；done 行不迁
    const queued = await store.listRuns("w1", { status: "queued" });
    expect(queued.length).toBe(1);
    expect(queued[0]?.context).toBe("pending-payload");
    // 旧表收尾删除
    for (const t of ["loops", "loop_runs", "trigger_queue"]) {
      const leftover = legacy
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(t);
      expect(leftover).toBeUndefined();
    }
  });
});
