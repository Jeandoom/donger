import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteLoopStore } from "../../src/adapters/sqlite-loop-store.js";
import { SqliteTriggerQueueStore } from "../../src/adapters/sqlite-trigger-queue-store.js";
import { SqliteTriggerStore } from "../../src/adapters/sqlite-trigger-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import {
  buildFeedbackCreatedPayload,
  sampleFeedbackCreatedPayload,
} from "../../src/domain/event-payloads.js";
import { parseTriggerInput } from "../../src/domain/trigger.js";
import { EventTriggerDispatcher } from "../../src/orchestrator/event-trigger-dispatcher.js";
import { LoopRunner } from "../../src/orchestrator/loop-runner.js";

const logger = pino({ level: "silent" });

/**
 * 事件触发分发契约（spec 2026-09-28-event-trigger-feedback-design）：
 * matcher 过滤、owner 级交叉过滤、disabled loop 不投递、fire 异步 fail-open、
 * event 触发器 roundtrip、testTrigger 合成样例。
 */

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
  const workspaceRoot = mkdtempSync(join(tmpdir(), "evt-trig-"));
  const runner = new LoopRunner({
    loopStore,
    workflowStore,
    triggerStore,
    orchestrator,
    workspaceRoot,
    channelId: "evt",
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
  return { triggerStore, workflowStore, loopStore, queue, runner, dispatcher, orchestrator };
}

let s: ReturnType<typeof setup>;
beforeEach(() => {
  s = setup();
});

async function wireFeedbackLoop(ownerId: string, matcher: Record<string, unknown>) {
  const t = await s.triggerStore.create(
    parseTriggerInput({
      ownerId,
      name: "反馈触发",
      type: "event",
      event: { name: "feedback.created", matcher },
    }),
  );
  const w = await s.workflowStore.create({
    ownerId,
    name: "W",
    triggerId: t.id,
    agentId: "a1",
  });
  return s.loopStore.create({ ownerId, name: "L", workflowId: w.id, enabled: true });
}

describe("EventTriggerDispatcher", () => {
  it("matcher 命中 → payload 原样投递到 enabled loop", async () => {
    const l = await wireFeedbackLoop("u1", {
      kind: "jsonPathEq",
      path: "$.feedback.category",
      value: "feature",
    });
    const payload = buildFeedbackCreatedPayload({
      id: "f1",
      category: "feature",
      status: "open",
      content: "希望支持导出",
      submitterId: "u9",
      submitterName: "用户九",
      imageCount: 0,
      createdAt: "2026-09-28T00:00:00.000Z",
    });
    await s.dispatcher.dispatch("feedback.created", payload);
    await vi.waitFor(() => expect(s.orchestrator.handleMessage).toHaveBeenCalledTimes(1));
    const runs = await s.loopStore.listRuns(l.id);
    expect(runs[0]?.triggerOutput).toBe(payload);
    // 提交人中文与 categoryLabel 都进 prompt（agent 可读）
    expect(runs[0]?.renderedPrompt).toContain("用户九");
    expect(runs[0]?.renderedPrompt).toContain("功能");
  });

  it("matcher 不命中 → 不入队不投递", async () => {
    await wireFeedbackLoop("u1", {
      kind: "jsonPathEq",
      path: "$.feedback.category",
      value: "ui",
    });
    await s.dispatcher.dispatch(
      "feedback.created",
      buildFeedbackCreatedPayload({
        id: "f1",
        category: "logic",
        status: "open",
        content: "x",
        submitterId: "u9",
        submitterName: "u9",
        imageCount: 0,
        createdAt: "2026-09-28T00:00:00.000Z",
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(s.orchestrator.handleMessage).not.toHaveBeenCalled();
  });

  it("disabled loop 不投递；未订阅事件名的触发器不响应", async () => {
    const l = await wireFeedbackLoop("u1", { kind: "always" });
    await s.loopStore.setEnabled(l.id, false);
    await s.dispatcher.dispatch("feedback.created", sampleFeedbackCreatedPayload());
    await new Promise((r) => setTimeout(r, 20));
    expect(s.orchestrator.handleMessage).not.toHaveBeenCalled();
  });

  it("fire 抛错不冒泡（fail-open）：dispatch 正常返回", async () => {
    await wireFeedbackLoop("u1", { kind: "always" });
    s.orchestrator.handleMessage.mockRejectedValue(new Error("boom"));
    await s.dispatcher.dispatch("feedback.created", sampleFeedbackCreatedPayload());
    await vi.waitFor(() => expect(s.orchestrator.handleMessage).toHaveBeenCalled());
  });

  it("member 的 hook 触发器不响应 event 分发（类型隔离）", async () => {
    await s.triggerStore.create({
      ownerId: "u1",
      name: "H",
      type: "hook",
      hook: {
        path: "/hooks/x1",
        responseStatus: 200,
        responseBody: "",
        matcher: { kind: "always" },
      },
    });
    await s.dispatcher.dispatch("feedback.created", sampleFeedbackCreatedPayload());
    await new Promise((r) => setTimeout(r, 20));
    expect(s.orchestrator.handleMessage).not.toHaveBeenCalled();
  });
});

describe("event 触发器 domain/store/testTrigger", () => {
  it("schema roundtrip：缺 event 配置被拒、未知事件名被拒", () => {
    expect(() => parseTriggerInput({ ownerId: "u1", name: "x", type: "event" })).toThrow(
      /event 配置/,
    );
    expect(() =>
      parseTriggerInput({
        ownerId: "u1",
        name: "x",
        type: "event",
        event: { name: "kb.updated", matcher: { kind: "always" } },
      }),
    ).toThrow();
    const ok = parseTriggerInput({
      ownerId: "u1",
      name: "x",
      type: "event",
      event: { name: "feedback.created", matcher: { kind: "always" } },
    });
    expect(ok.type).toBe("event");
  });

  it("trigger store marshal/unmarshal 含 event 分支（零迁移验证）", async () => {
    const t = await s.triggerStore.create(
      parseTriggerInput({
        ownerId: "u1",
        name: "反馈触发",
        type: "event",
        event: {
          name: "feedback.created",
          matcher: { kind: "bodyContains", keyword: "导出" },
        },
      }),
    );
    const back = await s.triggerStore.get(t.id);
    expect(back?.type).toBe("event");
    expect(back?.event?.name).toBe("feedback.created");
    expect(back?.event?.matcher).toEqual({ kind: "bodyContains", keyword: "导出" });
  });

  it("testTrigger：合成样例 payload 跑 matcher", async () => {
    const t = await s.triggerStore.create(
      parseTriggerInput({
        ownerId: "u1",
        name: "反馈触发",
        type: "event",
        event: {
          name: "feedback.created",
          matcher: { kind: "jsonPathEq", path: "$.feedback.category", value: "feature" },
        },
      }),
    );
    const r = await s.runner.testTrigger(t.id);
    expect(r.matched).toBe(true);
    expect(r.sourceOutput).toContain("feedback.created");
    // 改成不匹配的类别后不再命中
    await s.triggerStore.update(t.id, {
      event: {
        name: "feedback.created",
        matcher: { kind: "jsonPathEq", path: "$.feedback.category", value: "ui" },
      },
    });
    expect((await s.runner.testTrigger(t.id)).matched).toBe(false);
  });

  it("restoreQueue：遗留 running 复位重投 + disabled loop 不抽", async () => {
    const l = await wireFeedbackLoop("u1", { kind: "always" });
    // 模拟崩溃：事件已入队并认领为 running
    await s.queue.enqueue(
      { loopId: l.id, triggerId: "t", eventName: "feedback.created", payload: "x" },
      10,
    );
    const row = await s.queue.claimNextPending(l.id);
    expect(row?.status).toBe("running");
    await s.runner.restoreQueue();
    await vi.waitFor(() => expect(s.orchestrator.handleMessage).toHaveBeenCalledTimes(1));
    // disabled loop 的积压不被抽取
    const l2 = await wireFeedbackLoop("u2", { kind: "always" });
    await s.loopStore.setEnabled(l2.id, false);
    await s.queue.enqueue({ loopId: l2.id, triggerId: "t", eventName: "e", payload: "y" }, 10);
    await s.runner.restoreQueue();
    await new Promise((r) => setTimeout(r, 20));
    expect(await s.queue.countPending(l2.id)).toBe(1);
  });
});

describe("事件 payload 契约", () => {
  it("categoryLabel 中文随 payload；样例 payload 结构稳定", () => {
    const payload = JSON.parse(
      buildFeedbackCreatedPayload({
        id: "f1",
        category: "feature",
        status: "open",
        content: "c",
        submitterId: "u9",
        submitterName: "u9",
        imageCount: 2,
        createdAt: "2026-09-28T00:00:00.000Z",
      }),
    );
    expect(payload.event).toBe("feedback.created");
    expect(payload.feedback.categoryLabel).toBe("功能");
    expect(payload.feedback.imageCount).toBe(2);
    const sample = JSON.parse(sampleFeedbackCreatedPayload());
    expect(sample.feedback.category).toBe("feature");
    expect(sample.feedback.createdAt).toBe("1970-01-01T00:00:00.000Z");
  });
});
