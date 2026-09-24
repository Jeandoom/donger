import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { SqliteLoopStore } from "../../src/adapters/sqlite-loop-store.js";
import { SqliteTriggerStore } from "../../src/adapters/sqlite-trigger-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
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
  });
  return { db, triggerStore, workflowStore, loopStore, runner, orchestrator, workspaceRoot };
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

  it("skip-if-running: 并发调用只跑一次", async () => {
    const s = setup();
    s.orchestrator.handleMessage.mockImplementation(
      () => new Promise((res) => setTimeout(res, 50)),
    );
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
    await Promise.all([s.runner.fire(l.id, "a"), s.runner.fire(l.id, "b")]);
    expect(s.orchestrator.handleMessage).toHaveBeenCalledTimes(1);
  });
});
