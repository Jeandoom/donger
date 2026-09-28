import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { SqliteLoopStore } from "../../src/adapters/sqlite-loop-store.js";
import { SqliteTriggerQueueStore } from "../../src/adapters/sqlite-trigger-queue-store.js";
import { SqliteTriggerStore } from "../../src/adapters/sqlite-trigger-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import { EventTriggerDispatcher } from "../../src/orchestrator/event-trigger-dispatcher.js";
import { LoopRunner } from "../../src/orchestrator/loop-runner.js";

const logger = pino({ level: "silent" });

function setup() {
  const db = new Database(":memory:");
  const triggerStore = new SqliteTriggerStore(db);
  triggerStore.migrate();
  const workflowStore = new SqliteWorkflowStore(db);
  workflowStore.migrate();
  const loopStore = new SqliteLoopStore(db);
  loopStore.migrate();
  const queue = new SqliteTriggerQueueStore(db);
  queue.migrate();
  const orchestrator = { handleMessage: vi.fn().mockResolvedValue(undefined) };
  const workspaceRoot = mkdtempSync(join(tmpdir(), "loop-test-"));
  const runner = new LoopRunner({
    loopStore,
    workflowStore,
    triggerStore,
    orchestrator,
    workspaceRoot,
    channelId: "loop",
    logger,
    queue,
  });
  const dispatcher = new EventTriggerDispatcher({
    triggerStore,
    loopStore,
    workflowStore,
    loopRunner: runner,
    logger,
  });
  return {
    db,
    triggerStore,
    workflowStore,
    loopStore,
    queue,
    runner,
    dispatcher,
    orchestrator,
    workspaceRoot,
  };
}

describe("LoopRunner", () => {
  it("fire: matched → orchestrator.handleMessage 被调用 + LoopRun success", async () => {
    const s = setup();
    const t = await s.triggerStore.create({
      ownerId: "u1",
      name: "T",
      type: "hook",
      hook: {
        path: "/hooks/x",
        responseStatus: 200,
        responseBody: "ok",
        matcher: { kind: "always" },
      },
    });
    const w = await s.workflowStore.create({
      ownerId: "u1",
      name: "W",
      triggerId: t.id,
      agentId: "a1",
      promptTemplate: "do: {{triggerOutput}}",
    });
    const l = await s.loopStore.create({ ownerId: "u1", name: "L", workflowId: w.id });
    await s.runner.fire(l.id, "hello");
    expect(s.orchestrator.handleMessage).toHaveBeenCalledTimes(1);
    const runs = await s.loopStore.listRuns(l.id);
    expect(runs[0]?.status).toBe("success");
    // trigger source 按不可信内容包装（规格 §5.1）
    expect(runs[0]?.renderedPrompt).toContain('source="trigger-source"');
    expect(runs[0]?.renderedPrompt).toContain("do: ");
    expect(runs[0]?.renderedPrompt).toContain("hello");
  });

  it("testTrigger returns matched=true for bodyContains matcher", async () => {
    const s = setup();
    // file source 收口后仅允许工作区内路径：源文件落在 workspaceRoot 内
    writeFileSync(join(s.workspaceRoot, "src.txt"), "hello foo world");
    const t = await s.triggerStore.create({
      ownerId: "u1",
      name: "T",
      type: "scheduler",
      scheduler: {
        cron: "* * * * *",
        source: { type: "file", path: "src.txt" },
        matcher: { kind: "bodyContains", keyword: "foo" },
      },
    });
    const r = await s.runner.testTrigger(t.id);
    expect(r.matched).toBe(true);
    expect(r.sourceOutput).toContain("foo");
  });

  it("fire marks failed when workflow missing", async () => {
    const s = setup();
    const l = await s.loopStore.create({
      ownerId: "u1",
      name: "L",
      workflowId: "missing",
    });
    await s.runner.fire(l.id, "x");
    const runs = await s.loopStore.listRuns(l.id);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.error).toMatch(/workflow/i);
  });

  it("队列不丢：运行中到达的事件排队，run 结束后按序交付", async () => {
    const s = setup();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s.orchestrator.handleMessage.mockImplementation(async (msg) => {
      const tag = ["alpha", "beta", "gamma"].find((k) => msg.text.includes(k));
      order.push(tag ?? "?");
      if (order.length === 1) await gate; // 第一轮挂起，制造「忙」窗口
      return undefined;
    });
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
    // alpha 先入队并占住泵；beta/gamma 在运行中到达（旧语义会被 skip 丢弃）
    const first = s.runner.fire(l.id, "alpha");
    await vi.waitFor(() => expect(s.orchestrator.handleMessage).toHaveBeenCalledTimes(1));
    await Promise.all([s.runner.fire(l.id, "beta"), s.runner.fire(l.id, "gamma")]);
    expect(await s.queue.countPending(l.id)).toBe(2);
    release();
    await first;
    // FIFO 顺序交付
    expect(order).toEqual(["alpha", "beta", "gamma"]);
    expect(await s.queue.countPending(l.id)).toBe(0);
  });

  it("队列上限：pending 达上限后事件落 dropped 不执行", async () => {
    const s = setup();
    s.orchestrator.handleMessage.mockImplementation(() => new Promise(() => {})); // 永不结束，堵住泵
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
    const small = new LoopRunner({
      loopStore: s.loopStore,
      workflowStore: s.workflowStore,
      triggerStore: s.triggerStore,
      orchestrator: s.orchestrator,
      workspaceRoot: s.workspaceRoot,
      channelId: "loop",
      logger,
      queue: s.queue,
      maxQueuePending: 1,
    });
    // first 占住主泵（running 不计 pending）；second 被 small 认领为 running
    void s.runner.fire(l.id, "first");
    await vi.waitFor(() => expect(s.orchestrator.handleMessage).toHaveBeenCalledTimes(1));
    void small.fire(l.id, "second");
    await vi.waitFor(() => expect(s.orchestrator.handleMessage).toHaveBeenCalledTimes(2));
    // third：pending=0 < 上限 1 → 入队；fourth：pending=1 ≥ 上限 → dropped
    await small.fire(l.id, "third");
    await small.fire(l.id, "fourth");
    expect(await s.queue.countPending(l.id)).toBe(1);
  });
});
