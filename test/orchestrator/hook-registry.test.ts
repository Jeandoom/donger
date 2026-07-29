import Database from "better-sqlite3";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { SqliteLoopStore } from "../../src/adapters/sqlite-loop-store.js";
import { SqliteTriggerStore } from "../../src/adapters/sqlite-trigger-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import { HookRegistry } from "../../src/orchestrator/hook-registry.js";

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
    testTrigger: vi.fn(),
  };
  const reg = new HookRegistry({ triggerStore, loopStore, workflowStore, loopRunner, logger });
  return { db, triggerStore, workflowStore, loopStore, reg, loopRunner };
}

describe("HookRegistry", () => {
  it("404 when path not registered", async () => {
    const s = setup();
    const r = await s.reg.handle({ url: "/hooks/unknown", headers: {}, body: "" });
    expect(r.status).toBe(404);
  });

  it("matched: 200 + 固定 body + 异步触发 fire", async () => {
    const s = setup();
    const t = await s.triggerStore.create({
      ownerId: "u1",
      name: "T",
      type: "hook",
      hook: {
        path: "/hooks/dt",
        responseStatus: 200,
        responseBody: "success",
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
    const r = await s.reg.handle({ url: "/hooks/dt", headers: {}, body: '{"x":1}' });
    expect(r.status).toBe(200);
    expect(r.body).toBe("success");
    await new Promise((res) => setImmediate(res));
    expect(s.loopRunner.fire).toHaveBeenCalledWith(l.id, '{"x":1}');
  });

  it("not matched: still 200 + body, but fire not called", async () => {
    const s = setup();
    const t = await s.triggerStore.create({
      ownerId: "u1",
      name: "T",
      type: "hook",
      hook: {
        path: "/hooks/x",
        responseStatus: 200,
        responseBody: "ok",
        matcher: { kind: "bodyFieldEq", field: "type", value: "issue" },
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
    const r = await s.reg.handle({ url: "/hooks/x", headers: {}, body: '{"type":"comment"}' });
    expect(r.status).toBe(200);
    await new Promise((res) => setImmediate(res));
    expect(s.loopRunner.fire).not.toHaveBeenCalled();
  });

  it("loop disabled: 200 + body, fire not called", async () => {
    const s = setup();
    const t = await s.triggerStore.create({
      ownerId: "u1",
      name: "T",
      type: "hook",
      hook: {
        path: "/hooks/y",
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
    });
    await s.loopStore.create({ ownerId: "u1", name: "L", workflowId: w.id });
    const r = await s.reg.handle({ url: "/hooks/y", headers: {}, body: "" });
    expect(r.status).toBe(200);
    await new Promise((res) => setImmediate(res));
    expect(s.loopRunner.fire).not.toHaveBeenCalled();
  });
});
