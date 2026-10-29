import { describe, expect, it } from "vitest";
import { buildTeambitionEnvelope } from "../../src/domain/teambition.js";

describe("buildTeambitionEnvelope（webhook 载荷归一）", () => {
  it("任务事件 → 平台信封（topic=event、taskId 锚点、项目/租户 source）", () => {
    const env = buildTeambitionEnvelope({
      orgId: "org-1",
      timestamp: 1_770_000_000_000,
      event: "task.update",
      eventId: "evt-1",
      hookId: "hook-1",
      data: {
        operatorId: "member-7",
        task: { taskId: "task-9", projectId: "proj-2", content: "上线前回归", isDone: true },
      },
    });
    expect(env).toBeDefined();
    expect(env!.platform).toBe("teambition");
    expect(env!.topic).toBe("task.update");
    expect(env!.eventId).toBe("evt-1");
    expect(env!.sender).toEqual({ id: "member-7", name: "" });
    expect(env!.source).toEqual({ orgId: "org-1", projectId: "proj-2", taskId: "task-9" });
    expect(env!.text).toContain("上线前回归");
    expect(env!.replyAnchor).toEqual({
      platform: "teambition",
      kind: "task",
      taskId: "task-9",
      orgId: "org-1",
    });
    expect(env!.occurredAt).toBe(new Date(1_770_000_000_000).toISOString());
  });

  it("缺 event/eventId/taskId → undefined（不可归一，端点空应答）", () => {
    expect(buildTeambitionEnvelope({ event: "task.update" })).toBeUndefined();
    expect(buildTeambitionEnvelope({ eventId: "e" })).toBeUndefined();
    expect(
      buildTeambitionEnvelope({ event: "task.update", eventId: "e", data: { operatorId: "m" } }),
    ).toBeUndefined();
  });
});
