import { describe, expect, it } from "vitest";
import { EventSchema } from "../../src/domain/event.js";
import { WorkflowSchema } from "../../src/domain/workflow.js";
import { WorkflowRunSchema, WorkflowRunStatusSchema } from "../../src/domain/workflow-run.js";

describe("event schema", () => {
  it("parses conditional schedule event with jsonPathGt matcher", () => {
    const e = EventSchema.parse({
      id: "e1",
      ownerId: "u1",
      name: "每分钟探活",
      type: "schedule",
      schedule: {
        cron: "* * * * *",
        mode: "conditional",
        source: { type: "http", url: "https://x", method: "GET" },
        matcher: { kind: "jsonPathGt", path: "$.count", value: 10 },
      },
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
    });
    expect(e.type).toBe("schedule");
    expect(e.schedule?.matcher?.kind).toBe("jsonPathGt");
  });

  it("parses unconditional schedule event without source/matcher", () => {
    const e = EventSchema.parse({
      id: "e2",
      ownerId: "u1",
      name: "每天早报",
      type: "schedule",
      schedule: { cron: "0 9 * * *", mode: "unconditional" },
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
    });
    expect(e.schedule?.mode).toBe("unconditional");
    expect(e.schedule?.source).toBeUndefined();
  });

  it("rejects conditional schedule without source/matcher", () => {
    expect(() =>
      EventSchema.parse({
        id: "x",
        ownerId: "u1",
        name: "x",
        type: "schedule",
        schedule: { cron: "* * * * *", mode: "conditional" },
        createdAt: "x",
        updatedAt: "x",
      }),
    ).toThrow();
  });

  it("parses call event and rejects missing type config", () => {
    const e = EventSchema.parse({
      id: "e3",
      ownerId: "u1",
      name: "工单回调",
      type: "call",
      call: {
        path: "/hooks/abcdef01",
        methods: ["GET", "POST"],
        responseStatus: 200,
        responseBody: "success",
        matcher: { kind: "always" },
      },
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
    });
    expect(e.call?.path).toBe("/hooks/abcdef01");

    expect(() =>
      EventSchema.parse({
        id: "y",
        ownerId: "u1",
        name: "y",
        type: "system",
        createdAt: "x",
        updatedAt: "x",
      }),
    ).toThrow();
  });
});

describe("workflow schema", () => {
  it("parses with defaults for promptTemplate/enabled（outputSubdir 已移除）", () => {
    const w = WorkflowSchema.parse({
      id: "w1",
      ownerId: "u1",
      name: "抓取总结",
      eventId: "e1",
      agentId: "a1",
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
    });
    expect(w.promptTemplate).toBe("{{triggerOutput}}");
    expect(w.enabled).toBe(false);
    expect("outputSubdir" in w).toBe(false);
  });
});

describe("workflow run schema", () => {
  it("parses queued run with queue fields", () => {
    const r = WorkflowRunSchema.parse({
      id: "r1",
      workflowId: "w1",
      eventId: "e1",
      eventName: "schedule",
      status: "queued",
      queuedAt: "2026-07-29T00:00:00Z",
    });
    expect(r.status).toBe("queued");
    expect(r.conversationId ?? null).toBeNull();
  });

  it("status enum carries queued/running/success/failed/stopped", () => {
    expect([...WorkflowRunStatusSchema.options]).toEqual([
      "queued",
      "running",
      "success",
      "failed",
      "stopped",
    ]);
  });
});
