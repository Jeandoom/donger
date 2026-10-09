import Database from "better-sqlite3";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { SqliteEventFiringStore } from "../../src/adapters/sqlite-event-firing-store.js";
import { SqliteEventStore } from "../../src/adapters/sqlite-event-store.js";
import { SqliteWorkflowRunStore } from "../../src/adapters/sqlite-workflow-run-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import type { IncomingMessage } from "../../src/domain/types.js";
import type { WorkflowRun } from "../../src/domain/workflow-run.js";
import { EventDispatcher } from "../../src/orchestrator/event-dispatcher.js";

const logger = pino({ level: "silent" });

/** 泵是 fire-and-forget：轮询直到谓词成立（或超时暴露挂起）；谓词可为 async */
async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Setup {
  db: Database.Database;
  eventStore: SqliteEventStore;
  workflowStore: SqliteWorkflowStore;
  runStore: SqliteWorkflowRunStore;
  firingStore: SqliteEventFiringStore;
  dispatcher: EventDispatcher;
  orchestrator: { handleMessage: ReturnType<typeof vi.fn> };
  conversationStore: { createWithAgent: ReturnType<typeof vi.fn> };
  canceller: { cancelPendingApprovals: ReturnType<typeof vi.fn> };
}

function setup(over: { maxQueuePending?: number } = {}): Setup {
  const db = new Database(":memory:");
  const eventStore = new SqliteEventStore(db);
  eventStore.migrate();
  const workflowStore = new SqliteWorkflowStore(db);
  workflowStore.migrate();
  const runStore = new SqliteWorkflowRunStore(db);
  runStore.migrate();
  const firingStore = new SqliteEventFiringStore(db);
  firingStore.migrate();
  const orchestrator = { handleMessage: vi.fn().mockResolvedValue(undefined) };
  const conversationStore = { createWithAgent: vi.fn().mockResolvedValue({ id: "conv-1" }) };
  const canceller = { cancelPendingApprovals: vi.fn() };
  const dispatcher = new EventDispatcher({
    eventStore,
    workflowStore,
    runStore,
    firingStore,
    orchestrator,
    conversationStore,
    canceller,
    logger,
    maxQueuePending: over.maxQueuePending,
  });
  return {
    db,
    eventStore,
    workflowStore,
    runStore,
    firingStore,
    dispatcher,
    orchestrator,
    conversationStore,
    canceller,
  };
}

async function makeSubscribed(s: Setup, promptTemplate?: string) {
  const event = await s.eventStore.create({
    ownerId: "u1",
    name: "E",
    type: "schedule",
    schedule: { cron: "0 9 * * *", mode: "unconditional" },
  });
  const wf = await s.workflowStore.create({
    ownerId: "u1",
    name: "W",
    eventId: event.id,
    agentId: "a1",
    ...(promptTemplate ? { promptTemplate } : {}),
  });
  await s.workflowStore.setEnabled(wf.id, true);
  return { event, wf };
}

const runsOf = (s: Setup, workflowId: string) => s.runStore.listRuns(workflowId);

describe("EventDispatcher", () => {
  it("fire → 触发记录落行 + 扇出 + 独立运行会话 + success 回写", async () => {
    const s = setup();
    const { event, wf } = await makeSubscribed(s, "do: {{triggerOutput}}");
    await s.dispatcher.fire(event.id, { payload: "hello" }, "schedule");

    // 触发记录（永久保留）
    const firings = await s.firingStore.listByEvent(event.id);
    expect(firings.length).toBe(1);
    expect(firings[0]?.source).toBe("schedule");
    expect(firings[0]?.matchedWorkflowCount).toBe(1);
    expect(firings[0]?.context).toBe("hello");

    const run = await waitFor(async () => {
      const list = await runsOf(s, wf.id);
      return list[0]?.status === "success" ? list[0] : undefined;
    });
    // 每次执行独立运行会话（D1）+ conversationId 传入 orchestrator
    expect(s.conversationStore.createWithAgent).toHaveBeenCalledTimes(1);
    expect(s.conversationStore.createWithAgent.mock.calls[0]?.[2]).toContain("⚙️");
    const msg = s.orchestrator.handleMessage.mock.calls[0]?.[0] as IncomingMessage;
    expect(msg.conversationId).toBe("conv-1");
    expect(msg.unattended).toBe(true);
    // triggerOutput 按不可信内容包装（规格 §5.1）+ 模板渲染
    expect(run.renderedPrompt).toContain('source="event"');
    expect(run.renderedPrompt).toContain("do: ");
    expect(run.renderedPrompt).toContain("hello");
    // workflow 运行态回写
    expect((await s.workflowStore.get(wf.id))?.lastRunId).toBe(run.id);
  });

  it("队列容量：溢出那次直接 failed，原因进执行记录（D6）", async () => {
    const s = setup({ maxQueuePending: 2 });
    const { event, wf } = await makeSubscribed(s);
    // orchestrator 挂起：首轮保持 running，占住认领通道
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    s.orchestrator.handleMessage.mockImplementation(() => gate);

    await s.dispatcher.fire(event.id, { payload: "a" }, "schedule");
    await waitFor(async () => (await runsOf(s, wf.id)).some((r) => r.status === "running"));
    await s.dispatcher.fire(event.id, { payload: "b" }, "schedule");
    await s.dispatcher.fire(event.id, { payload: "c" }, "schedule");
    await s.dispatcher.fire(event.id, { payload: "d" }, "schedule");

    const runs = await waitFor(async () => {
      const list = await runsOf(s, wf.id);
      return list.length === 4 ? list : undefined;
    });
    const failed = runs.find((r) => r.status === "failed");
    expect(failed?.context).toBe("d");
    expect(failed?.error).toContain("队列已满");
    expect(failed?.finishedAt ?? null).not.toBeNull();
    // 失败也回写 workflow lastError（列表可见）
    expect((await s.workflowStore.get(wf.id))?.lastError).toContain("队列已满");
    release();
  });

  it("手动运行豁免容量，仍入队走同一泵", async () => {
    const s = setup({ maxQueuePending: 1 });
    const { wf } = await makeSubscribed(s);
    const run = await s.dispatcher.manualRun(wf.id, { payload: "manual-ctx" });
    expect(run.status).toBe("queued");
    await waitFor(async () => {
      const list = await runsOf(s, wf.id);
      return list[0]?.status === "success" ? true : undefined;
    });
  });

  it("stopRun：运行中 → 标记 stopped + 解开会话挂起审批", async () => {
    const s = setup();
    const { wf } = await makeSubscribed(s);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    s.orchestrator.handleMessage.mockImplementation(() => gate);
    await s.dispatcher.manualRun(wf.id, { payload: "x" });
    const running = await waitFor(async () => {
      const list = await runsOf(s, wf.id);
      return list[0]?.status === "running" ? list[0] : undefined;
    });
    const stopped = await s.dispatcher.stopRun(wf.id, running.id);
    expect(stopped.status).toBe("stopped");
    expect(s.canceller.cancelPendingApprovals).toHaveBeenCalledWith("conv-1");
    release();
  });

  it("restore：遗留 running → queued 重投（at-least-once）", async () => {
    const s = setup();
    const { wf } = await makeSubscribed(s);
    await s.runStore.insert({
      id: "stale",
      workflowId: wf.id,
      eventId: "",
      firingId: null,
      eventName: "schedule",
      status: "running",
      context: "x",
      queuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    } satisfies WorkflowRun);
    await s.dispatcher.restore();
    await waitFor(async () => {
      const list = await runsOf(s, wf.id);
      return list[0]?.status === "success" ? true : undefined;
    });
    expect(s.orchestrator.handleMessage).toHaveBeenCalledTimes(1);
  });

  it("workflow 缺失 → run failed 且不留悬挂", async () => {
    const s = setup();
    await s.runStore.insert({
      id: "orphan",
      workflowId: "missing",
      eventId: "",
      firingId: null,
      eventName: "manual",
      status: "queued",
      queuedAt: new Date().toISOString(),
    } satisfies WorkflowRun);
    s.dispatcher.pump();
    const run = await waitFor(async () => {
      const loaded = await s.runStore.getRun("orphan");
      return loaded?.status === "failed" ? loaded : undefined;
    });
    expect(run.error).toMatch(/workflow/i);
  });

  it("停用的订阅者不扇出", async () => {
    const s = setup();
    const { event, wf } = await makeSubscribed(s);
    await s.workflowStore.setEnabled(wf.id, false);
    await s.dispatcher.fire(event.id, { payload: "x" }, "schedule");
    const firings = await s.firingStore.listByEvent(event.id);
    expect(firings[0]?.matchedWorkflowCount).toBe(0);
    expect((await runsOf(s, wf.id)).length).toBe(0);
  });
});
