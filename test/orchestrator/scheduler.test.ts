import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteEventStore } from "../../src/adapters/sqlite-event-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import { SchedulerService } from "../../src/orchestrator/scheduler.js";

const logger = pino({ level: "silent" });

describe("SchedulerService", () => {
  let db: Database.Database;
  let eventStore: SqliteEventStore;
  let workflowStore: SqliteWorkflowStore;
  let dispatcher: { fire: ReturnType<typeof vi.fn> };
  let scheduler: SchedulerService;
  let workspaceRoot: string;

  beforeEach(() => {
    db = new Database(":memory:");
    eventStore = new SqliteEventStore(db);
    eventStore.migrate();
    workflowStore = new SqliteWorkflowStore(db);
    workflowStore.migrate();
    dispatcher = { fire: vi.fn().mockResolvedValue(undefined) };
    workspaceRoot = mkdtempSync(join(tmpdir(), "sched-test-"));
    scheduler = new SchedulerService({
      eventStore,
      workflowStore,
      dispatcher: dispatcher as never,
      logger,
      workspaceRoot,
    });
  });

  it("无 enabled 订阅者不注册；注册后 nextRunAt 可算", async () => {
    const e = await eventStore.create({
      ownerId: "u1",
      name: "早报",
      type: "schedule",
      schedule: { cron: "0 9 * * *", mode: "unconditional" },
    });
    await scheduler.register(e);
    expect(scheduler.size()).toBe(0);

    const wf = await workflowStore.create({
      ownerId: "u1",
      name: "W",
      eventId: e.id,
      agentId: "a1",
    });
    await workflowStore.setEnabled(wf.id, true);
    await scheduler.refreshByEvent(e.id);
    expect(scheduler.size()).toBe(1);
  });

  it("unconditional tick 到点直接 fire（payload 携带 firedAt）", async () => {
    const e = await eventStore.create({
      ownerId: "u1",
      name: "早报",
      type: "schedule",
      schedule: { cron: "0 9 * * *", mode: "unconditional" },
    });
    const wf = await workflowStore.create({
      ownerId: "u1",
      name: "W",
      eventId: e.id,
      agentId: "a1",
    });
    await workflowStore.setEnabled(wf.id, true);
    await (scheduler as unknown as { tick(id: string): Promise<void> }).tick(e.id);
    expect(dispatcher.fire).toHaveBeenCalledTimes(1);
    const [eventId, ctx, source] = dispatcher.fire.mock.calls[0] as [
      string,
      { payload: string },
      string,
    ];
    expect(eventId).toBe(e.id);
    expect(source).toBe("schedule");
    const payload = JSON.parse(ctx.payload) as { event: string; firedAt: string };
    expect(payload.event).toBe("timer");
    expect(payload.firedAt).toBeTruthy();
  });

  it("conditional tick：抓工作区内文件源 + matcher 判定，命中才 fire", async () => {
    writeFileSync(join(workspaceRoot, "src.txt"), "hello foo world");
    const e = await eventStore.create({
      ownerId: "u1",
      name: "探活",
      type: "schedule",
      schedule: {
        cron: "* * * * *",
        mode: "conditional",
        source: { type: "file", path: "src.txt" },
        matcher: { kind: "bodyContains", keyword: "foo" },
      },
    });
    const wf = await workflowStore.create({
      ownerId: "u1",
      name: "W",
      eventId: e.id,
      agentId: "a1",
    });
    await workflowStore.setEnabled(wf.id, true);
    await (scheduler as unknown as { tick(id: string): Promise<void> }).tick(e.id);
    expect(dispatcher.fire).toHaveBeenCalledTimes(1);
    const [, ctx] = dispatcher.fire.mock.calls[0] as [string, { payload: string }];
    expect(ctx.payload).toContain("foo");

    // 未命中：不 fire
    const e2 = await eventStore.create({
      ownerId: "u1",
      name: "探活2",
      type: "schedule",
      schedule: {
        cron: "* * * * *",
        mode: "conditional",
        source: { type: "file", path: "src.txt" },
        matcher: { kind: "bodyContains", keyword: "absent" },
      },
    });
    await workflowStore.create({ ownerId: "u1", name: "W2", eventId: e2.id, agentId: "a1" });
    const wf2 = (await workflowStore.listByOwner("u1")).find((w) => w.eventId === e2.id)!;
    await workflowStore.setEnabled(wf2.id, true);
    await (scheduler as unknown as { tick(id: string): Promise<void> }).tick(e2.id);
    expect(dispatcher.fire).toHaveBeenCalledTimes(1);
  });

  it("订阅者停用后 refreshByEvent 注销 cron", async () => {
    const e = await eventStore.create({
      ownerId: "u1",
      name: "早报",
      type: "schedule",
      schedule: { cron: "0 9 * * *", mode: "unconditional" },
    });
    const wf = await workflowStore.create({
      ownerId: "u1",
      name: "W",
      eventId: e.id,
      agentId: "a1",
    });
    await workflowStore.setEnabled(wf.id, true);
    await scheduler.refreshByEvent(e.id);
    expect(scheduler.size()).toBe(1);
    await workflowStore.setEnabled(wf.id, false);
    await scheduler.refreshByEvent(e.id);
    expect(scheduler.size()).toBe(0);
  });
});
