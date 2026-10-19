import Database from "better-sqlite3";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { SqliteEventFiringStore } from "../../src/adapters/sqlite-event-firing-store.js";
import { SqliteEventStore } from "../../src/adapters/sqlite-event-store.js";
import { SqliteWorkflowRunStore } from "../../src/adapters/sqlite-workflow-run-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import type { Event } from "../../src/domain/event.js";
import {
  AGENT_EXECUTION_COMPLETED_EVENT,
  type ExecutionCompletedFact,
  WORKFLOW_EXECUTION_COMPLETED_EVENT,
  WORKFLOW_COMPLETION_BRIEFING_TEMPLATE,
  buildExecutionCompletedPayload,
  parseExecutionCompletedPayload,
} from "../../src/domain/event-payloads.js";
import { EventDispatcher } from "../../src/orchestrator/event-dispatcher.js";
import { SystemEventDispatcher } from "../../src/orchestrator/system-event-dispatcher.js";

const logger = pino({ level: "silent" });

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
  systemEvents: SystemEventDispatcher;
  orchestrator: { handleMessage: ReturnType<typeof vi.fn> };
  messageStore: { listByConversation: ReturnType<typeof vi.fn> };
}

function setup(over: { maxCascadeDepth?: number } = {}): Setup {
  const db = new Database(":memory:");
  const eventStore = new SqliteEventStore(db);
  eventStore.migrate();
  const workflowStore = new SqliteWorkflowStore(db);
  workflowStore.migrate();
  const runStore = new SqliteWorkflowRunStore(db);
  runStore.migrate();
  const firingStore = new SqliteEventFiringStore(db);
  firingStore.migrate();
  const orchestrator = { handleMessage: vi.fn().mockResolvedValue("conv-1") };
  const conversationStore = { createWithAgent: vi.fn().mockResolvedValue({ id: "conv-1" }) };
  const messageStore = {
    listByConversation: vi.fn().mockResolvedValue([{ role: "bot", text: "A 的结论：修复完成" }]),
  };
  const agentStore = {
    get: vi.fn().mockImplementation(async (id: string) => ({ name: `agent-${id}` })),
  };
  const dispatcher = new EventDispatcher({
    eventStore,
    workflowStore,
    runStore,
    firingStore,
    orchestrator,
    conversationStore,
    logger,
    maxCascadeDepth: over.maxCascadeDepth,
    messageStore,
    agentStore,
  });
  const systemEvents = new SystemEventDispatcher({ eventStore, dispatcher, logger });
  dispatcher.setSystemEventSink(systemEvents);
  return {
    db,
    eventStore,
    workflowStore,
    runStore,
    firingStore,
    dispatcher,
    systemEvents,
    orchestrator,
    messageStore,
  };
}

async function makeWorkflow(
  s: Setup,
  opts: { ownerId: string; name: string; eventId: string; agentId: string; prompt?: string },
) {
  const wf = await s.workflowStore.create({
    ownerId: opts.ownerId,
    name: opts.name,
    eventId: opts.eventId,
    agentId: opts.agentId,
    ...(opts.prompt ? { promptTemplate: opts.prompt } : {}),
  });
  await s.workflowStore.setEnabled(wf.id, true);
  return wf;
}

function makeCompletionEvent(
  ownerId: string,
  subjects: string[],
  timing?: "all" | "success" | "failed" | "stopped",
): Omit<Event, "id" | "createdAt" | "updatedAt" | "lastFiredAt" | "nextRunAt"> {
  return {
    ownerId,
    name: `完成事件-${subjects.join(",")}`,
    type: "system",
    system: { name: AGENT_EXECUTION_COMPLETED_EVENT, subjects, ...(timing ? { timing } : {}) },
  };
}

const runsOf = (s: Setup, workflowId: string) => s.runStore.listRuns(workflowId);

describe("执行完成事件（spec 2026-10-19-execution-completion-events-design §13）", () => {
  it("§13.1 链式两跳：A 完成触发 B，B 的简报含 A 的结论；级联两列落库", async () => {
    const s = setup();
    const scheduleEvent = await s.eventStore.create({
      ownerId: "u1",
      name: "定时",
      type: "schedule",
      schedule: { cron: "0 9 * * *", mode: "unconditional" },
    });
    const wfA = await makeWorkflow(s, {
      ownerId: "u1",
      name: "工作流A",
      eventId: scheduleEvent.id,
      agentId: "a1",
    });
    const completionEvent = await s.eventStore.create(makeCompletionEvent("u1", ["a1"]));
    const wfB = await makeWorkflow(s, {
      ownerId: "u1",
      name: "工作流B",
      eventId: completionEvent.id,
      agentId: "b1",
      prompt: WORKFLOW_COMPLETION_BRIEFING_TEMPLATE,
    });

    await s.dispatcher.fire(scheduleEvent.id, { payload: "kick" }, "schedule");

    const runA = await waitFor(async () => {
      const list = await runsOf(s, wfA.id);
      return list[0]?.status === "success" ? list[0] : undefined;
    });
    // 链根：schedule 触发，深度 0
    expect(runA.cascadeDepth).toBe(0);
    expect(runA.causedByRunId ?? null).toBeNull();

    // B 被完成事件触发，简报变量渲染（下游收自然语言简报，非 JSON）
    const runB = await waitFor(async () => {
      const list = await runsOf(s, wfB.id);
      return list[0]?.status === "success" ? list[0] : undefined;
    });
    expect(runB.renderedPrompt).toContain("【上游完成通知】");
    expect(runB.renderedPrompt).toContain("工作流A");
    expect(runB.renderedPrompt).toContain("agent-a1");
    expect(runB.renderedPrompt).toContain("A 的结论：修复完成");
    expect(runB.renderedPrompt).toContain("（无）");
    // 级联两列：B 的上游 = A 的 run，深度 +1
    expect(runB.causedByRunId).toBe(runA.id);
    expect(runB.cascadeDepth).toBe(1);
  });

  it("§13.2 级联截断：链深超限拒绝入队，落 failed + 通知语义", async () => {
    const s = setup({ maxCascadeDepth: 2 });
    const completionEvent = await s.eventStore.create(makeCompletionEvent("u1", ["a1"]));
    const wfB = await makeWorkflow(s, {
      ownerId: "u1",
      name: "工作流B",
      eventId: completionEvent.id,
      agentId: "b1",
    });
    const fact: ExecutionCompletedFact = {
      schemaVersion: 1,
      event: AGENT_EXECUTION_COMPLETED_EVENT,
      runId: "upstream-run",
      agentId: "a1",
      agentName: "agent-a1",
      workflowId: "wf-up",
      workflowName: "上游",
      ownerId: "u1",
      status: "success",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 100,
      error: null,
      trigger: { source: "event", eventId: null, causedByRunId: null, cascadeDepth: 2 },
      result: { text: "x", files: [] },
    };
    await s.dispatcher.fire(completionEvent.id, { payload: buildExecutionCompletedPayload(fact) }, "system");

    const run = await waitFor(async () => {
      const list = await runsOf(s, wfB.id);
      return list[0] ? list[0] : undefined;
    });
    expect(run.status).toBe("failed");
    expect(run.error).toContain("级联深度超限");
    expect(run.cascadeDepth).toBe(3);
    expect(run.causedByRunId).toBe("upstream-run");
    // 截断的 run 不再 emit（否则失败订阅者链会继续放大）
    expect(s.orchestrator.handleMessage).not.toHaveBeenCalled();
  });

  it("§13.4 属主隔离：他人名下的执行不触发我的订阅", async () => {
    const s = setup();
    const completionEvent = await s.eventStore.create(makeCompletionEvent("u1", ["a1"]));
    const wfB = await makeWorkflow(s, {
      ownerId: "u1",
      name: "工作流B",
      eventId: completionEvent.id,
      agentId: "b1",
    });
    const fact: ExecutionCompletedFact = {
      schemaVersion: 1,
      event: AGENT_EXECUTION_COMPLETED_EVENT,
      runId: "other-run",
      agentId: "a1",
      agentName: "agent-a1",
      workflowId: "wf-other",
      workflowName: "他人工作流",
      ownerId: "u2",
      status: "success",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 100,
      error: null,
      trigger: { source: "manual", eventId: null, causedByRunId: null, cascadeDepth: 0 },
      result: { text: "他人的结论", files: [] },
    };
    await s.systemEvents.dispatch(
      AGENT_EXECUTION_COMPLETED_EVENT,
      buildExecutionCompletedPayload(fact),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect((await runsOf(s, wfB.id)).length).toBe(0);
  });

  it("§13.5 timing 过滤：timing=success 只在成功时触发", async () => {
    const s = setup();
    const completionEvent = await s.eventStore.create(makeCompletionEvent("u1", ["a1"], "success"));
    const wfB = await makeWorkflow(s, {
      ownerId: "u1",
      name: "工作流B",
      eventId: completionEvent.id,
      agentId: "b1",
    });
    const base = {
      schemaVersion: 1,
      event: AGENT_EXECUTION_COMPLETED_EVENT,
      runId: "r1",
      agentId: "a1",
      agentName: "agent-a1",
      workflowId: "wf-a",
      workflowName: "A",
      ownerId: "u1",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 10,
      error: null,
      trigger: { source: "event", eventId: null, causedByRunId: null, cascadeDepth: 0 },
      result: { text: "", files: [] },
    } satisfies ExecutionCompletedFact;
    await s.systemEvents.dispatch(
      AGENT_EXECUTION_COMPLETED_EVENT,
      buildExecutionCompletedPayload({ ...base, status: "failed" }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect((await runsOf(s, wfB.id)).length).toBe(0);

    await s.systemEvents.dispatch(
      AGENT_EXECUTION_COMPLETED_EVENT,
      buildExecutionCompletedPayload({ ...base, status: "success" }),
    );
    await waitFor(async () => ((await runsOf(s, wfB.id)).length === 1 ? true : undefined));
  });

  it("§13.6 两类事件并存：同一 run 同时命中智能体视角与工作流视角，各自扇出", async () => {
    const s = setup();
    const scheduleEvent = await s.eventStore.create({
      ownerId: "u1",
      name: "定时",
      type: "schedule",
      schedule: { cron: "0 9 * * *", mode: "unconditional" },
    });
    const wfA = await makeWorkflow(s, {
      ownerId: "u1",
      name: "工作流A",
      eventId: scheduleEvent.id,
      agentId: "a1",
    });
    const agentEvent = await s.eventStore.create(makeCompletionEvent("u1", ["a1"]));
    const workflowEvent = await s.eventStore.create({
      ownerId: "u1",
      name: "工作流A完成",
      type: "system",
      system: { name: WORKFLOW_EXECUTION_COMPLETED_EVENT, subjects: [wfA.id] },
    });
    const wfB = await makeWorkflow(s, {
      ownerId: "u1",
      name: "B-智能体视角",
      eventId: agentEvent.id,
      agentId: "b1",
    });
    const wfC = await makeWorkflow(s, {
      ownerId: "u1",
      name: "C-工作流视角",
      eventId: workflowEvent.id,
      agentId: "c1",
    });

    await s.dispatcher.fire(scheduleEvent.id, { payload: "kick" }, "schedule");
    await waitFor(async () => {
      const [b, c] = await Promise.all([runsOf(s, wfB.id), runsOf(s, wfC.id)]);
      return b[0]?.status === "success" && c[0]?.status === "success" ? true : undefined;
    });
  });

  it("§13.7 手动运行同样 emit，payload 信封字段正确（result.text=最终回复）", async () => {
    const s = setup();
    const completionEvent = await s.eventStore.create(makeCompletionEvent("u1", ["a1"]));
    const wfA = await makeWorkflow(s, {
      ownerId: "u1",
      name: "工作流A",
      eventId: completionEvent.id,
      agentId: "a1",
    });
    const spy = vi.fn().mockResolvedValue(undefined);
    s.dispatcher.setSystemEventSink({ dispatch: spy });

    await s.dispatcher.manualRun(wfA.id, { payload: "manual-kick" });
    await waitFor(async () => (spy.mock.calls.length >= 2 ? true : undefined));

    const names = spy.mock.calls.map((c) => c[0] as string);
    expect(names).toContain(AGENT_EXECUTION_COMPLETED_EVENT);
    expect(names).toContain(WORKFLOW_EXECUTION_COMPLETED_EVENT);
    const agentPayload = spy.mock.calls.find((c) => c[0] === AGENT_EXECUTION_COMPLETED_EVENT)?.[1] as string;
    const fact = parseExecutionCompletedPayload(agentPayload);
    expect(fact).not.toBeNull();
    expect(fact?.ownerId).toBe("u1");
    expect(fact?.status).toBe("success");
    expect(fact?.result.text).toBe("A 的结论：修复完成");
    expect(fact?.trigger.source).toBe("manual");
    expect(fact?.result.files).toEqual([]);
  });

  it("§13.8 存量回归：feedback.created matcher 路径不受影响；非完成事件 payload 不误入级联", async () => {
    const s = setup();
    const feedbackEvent = await s.eventStore.create({
      ownerId: "u1",
      name: "反馈",
      type: "system",
      system: { name: "feedback.created", matcher: { kind: "bodyContains", keyword: "报销" } },
    });
    const wf = await makeWorkflow(s, {
      ownerId: "u1",
      name: "W",
      eventId: feedbackEvent.id,
      agentId: "a1",
    });
    const sink = vi.fn().mockResolvedValue(undefined);
    s.dispatcher.setSystemEventSink({ dispatch: sink });

    await s.systemEvents.dispatch(
      "feedback.created",
      JSON.stringify({ event: "feedback.created", feedback: { content: "报销单据异常" } }),
    );
    await waitFor(async () => ((await runsOf(s, wf.id)).length === 1 ? true : undefined));
    // matcher 命中路径照常；非完成事件 payload 不产生级联链（深度 0、无上游）
    const run = (await runsOf(s, wf.id))[0];
    expect(run?.cascadeDepth).toBe(0);
    expect(run?.causedByRunId ?? null).toBeNull();
    // 该 run 完成时照常 emit（每个 run 终态都发完成事件），但 source=system 事件触发 → event
    await waitFor(async () => (sink.mock.calls.length >= 2 ? true : undefined));
    const payload = sink.mock.calls[0]?.[1] as string;
    expect(parseExecutionCompletedPayload(payload)?.trigger.source).toBe("event");
  });
});
