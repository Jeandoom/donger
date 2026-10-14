import { describe, expect, it } from "vitest";
import { parseWorkflowInput, WorkflowSchema } from "../../src/domain/workflow.js";

describe("WorkflowSchema.permissionMode", () => {
  it("输入缺省即完全权限（2026-10-14 拍板：工作流配置为准，缺省 full_access）", () => {
    const w = WorkflowSchema.parse({
      id: "w1",
      ownerId: "u1",
      name: "W",
      eventId: "e1",
      agentId: "a1",
      createdAt: "now",
      updatedAt: "now",
    });
    expect(w.permissionMode).toBe("full_access");
  });

  it("parseWorkflowInput 接受三档合法值并透传", () => {
    for (const permissionMode of ["ask_before_change", "risk_guard", "full_access"] as const) {
      const input = parseWorkflowInput({
        ownerId: "u1",
        name: "W",
        eventId: "e1",
        agentId: "a1",
        permissionMode,
      });
      expect(input.permissionMode).toBe(permissionMode);
    }
  });

  it("非法模式值拒绝", () => {
    expect(() =>
      parseWorkflowInput({
        ownerId: "u1",
        name: "W",
        eventId: "e1",
        agentId: "a1",
        permissionMode: "yolo",
      }),
    ).toThrow();
  });
});
