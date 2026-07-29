import Database from "better-sqlite3";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { SqliteLoopStore } from "../../src/adapters/sqlite-loop-store.js";
import { SqliteTriggerStore } from "../../src/adapters/sqlite-trigger-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import { SchedulerService } from "../../src/orchestrator/scheduler.js";

const logger = pino({ level: "silent" });

function setup() {
  const db = new Database(":memory:");
  const triggerStore = new SqliteTriggerStore(db);
  triggerStore.migrate();
  const workflowStore = new SqliteWorkflowStore(db);
  workflowStore.migrate();
  const loopStore = new SqliteLoopStore(db);
  loopStore.migrate();
  const loopRunner = {
    fire: vi.fn().mockResolvedValue(undefined),
    testTrigger: vi.fn().mockResolvedValue({ matched: true, sourceOutput: "x" }),
  };
  const scheduler = new SchedulerService({
    loopStore,
    workflowStore,
    triggerStore,
    loopRunner,
    logger,
  });
  return { db, triggerStore, workflowStore, loopStore, scheduler, loopRunner };
}

describe("SchedulerService", () => {
  it("restore registers all enabled scheduler loops", async () => {
    const s = setup();
    const t = await s.triggerStore.create({
      ownerId: "u1",
      name: "T",
      type: "scheduler",
      scheduler: {
        cron: "* * * * *",
        source: { type: "file", path: "/x" },
        matcher: { kind: "always" },
      },
    });
    const w = await s.workflowStore.create({
      ownerId: "u1",
      name: "W",
      triggerId: t.id,
      agentId: "a1",
    });
    const l = await s.loopStore.create({ ownerId: "u1", name: "L", workflowId: w.id });
    await s.loopStore.setEnabled(l.id, true);
    await s.scheduler.restore();
    expect(s.scheduler.size()).toBe(1);
    s.scheduler.stopAll();
  });

  it("register/unregister toggles", async () => {
    const s = setup();
    const t = await s.triggerStore.create({
      ownerId: "u1",
      name: "T",
      type: "scheduler",
      scheduler: {
        cron: "* * * * *",
        source: { type: "file", path: "/x" },
        matcher: { kind: "always" },
      },
    });
    const w = await s.workflowStore.create({
      ownerId: "u1",
      name: "W",
      triggerId: t.id,
      agentId: "a1",
    });
    const l = await s.loopStore.create({ ownerId: "u1", name: "L", workflowId: w.id });
    await s.scheduler.register(l);
    // register 是异步 resolve cron expr，需要微任务
    await new Promise((res) => setImmediate(res));
    expect(s.scheduler.size()).toBe(1);
    s.scheduler.unregister(l.id);
    expect(s.scheduler.size()).toBe(0);
  });

  it("hook trigger loops are NOT registered in scheduler", async () => {
    const s = setup();
    const t = await s.triggerStore.create({
      ownerId: "u1",
      name: "T",
      type: "hook",
      hook: {
        path: "/hooks/x",
        responseStatus: 200,
        responseBody: "",
        matcher: { kind: "always" },
      },
    });
    const w = await s.workflowStore.create({
      ownerId: "u1",
      name: "W",
      triggerId: t.id,
      agentId: "a1",
    });
    const l = await s.loopStore.create({ ownerId: "u1", name: "L", workflowId: w.id });
    await s.loopStore.setEnabled(l.id, true);
    await s.scheduler.restore();
    expect(s.scheduler.size()).toBe(0);
  });

  it("invalid cron skips registration", async () => {
    const s = setup();
    const t = await s.triggerStore.create({
      ownerId: "u1",
      name: "T",
      type: "scheduler",
      scheduler: {
        cron: "not a cron",
        source: { type: "file", path: "/x" },
        matcher: { kind: "always" },
      },
    });
    const w = await s.workflowStore.create({
      ownerId: "u1",
      name: "W",
      triggerId: t.id,
      agentId: "a1",
    });
    const l = await s.loopStore.create({ ownerId: "u1", name: "L", workflowId: w.id });
    await s.loopStore.setEnabled(l.id, true);
    await s.scheduler.restore();
    expect(s.scheduler.size()).toBe(0);
  });
});
