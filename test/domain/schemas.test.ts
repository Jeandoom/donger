import { describe, expect, it } from "vitest";
import { LoopRunSchema, LoopSchema } from "../../src/domain/loop.js";
import { TriggerSchema } from "../../src/domain/trigger.js";
import { WorkflowSchema } from "../../src/domain/workflow.js";

describe("trigger schema", () => {
  it("parses scheduler trigger with http source + jsonPathGt matcher", () => {
    const t = TriggerSchema.parse({
      id: "t1",
      ownerId: "u1",
      name: "每分钟探活",
      type: "scheduler",
      scheduler: {
        cron: "* * * * *",
        source: { type: "http", url: "https://x", method: "GET" },
        matcher: { kind: "jsonPathGt", path: "$.count", value: 10 },
      },
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
    });
    expect(t.type).toBe("scheduler");
    expect(t.scheduler?.matcher.kind).toBe("jsonPathGt");
  });

  it("parses hook trigger with bodyFieldEq matcher", () => {
    const t = TriggerSchema.parse({
      id: "t2",
      ownerId: "u1",
      name: "钉钉事件",
      type: "hook",
      hook: {
        path: "/hooks/dingtalk",
        responseStatus: 200,
        responseBody: "success",
        matcher: { kind: "bodyFieldEq", field: "type", value: "issue" },
      },
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
    });
    expect(t.hook?.path).toBe("/hooks/dingtalk");
  });

  it("rejects trigger without matching type config", () => {
    expect(() =>
      TriggerSchema.parse({
        id: "x",
        ownerId: "u1",
        name: "x",
        type: "scheduler",
        createdAt: "x",
        updatedAt: "x",
      }),
    ).toThrow();
  });
});

describe("workflow schema", () => {
  it("parses with defaults for promptTemplate and outputSubdir", () => {
    const w = WorkflowSchema.parse({
      id: "w1",
      ownerId: "u1",
      name: "抓取总结",
      triggerId: "t1",
      agentId: "a1",
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
    });
    expect(w.promptTemplate).toBe("{{triggerOutput}}");
    expect(w.outputSubdir).toBe("outputs/");
  });
});

describe("loop schema", () => {
  it("parses minimal loop with default tags and enabled=false", () => {
    const l = LoopSchema.parse({
      id: "l1",
      ownerId: "u1",
      name: "晨报",
      workflowId: "w1",
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
    });
    expect(l.enabled).toBe(false);
    expect(l.tags).toEqual([]);
  });

  it("parses loop run", () => {
    const r = LoopRunSchema.parse({
      id: "r1",
      loopId: "l1",
      workflowId: "w1",
      triggerId: "t1",
      agentId: "a1",
      status: "running",
      startedAt: "2026-07-29T00:00:00Z",
    });
    expect(r.status).toBe("running");
  });
});
