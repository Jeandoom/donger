import { describe, expect, it } from "vitest";
import { beginStep, completeStep, type FlowStep } from "../../src/domain/task-flow.js";

const NOW = "2026-09-08T00:00:00.000Z";
const init = { role: "dispatcher" as const, agentId: "builtin-dispatcher", conversationId: "c1" };

describe("task-flow", () => {
  it("beginStep：空链从 seq 0 起，状态 running", () => {
    const steps = beginStep([], { ...init, startedAt: NOW });
    expect(steps).toEqual([
      {
        seq: 0,
        status: "running",
        role: "dispatcher",
        agentId: "builtin-dispatcher",
        conversationId: "c1",
        startedAt: NOW,
      },
    ]);
  });

  it("beginStep：seq 递增，不可变（不改原数组）", () => {
    const first = beginStep([], { ...init, startedAt: NOW });
    const second = beginStep(first, {
      role: "agent",
      agentId: "a1",
      conversationId: "c1",
      startedAt: NOW,
    });
    expect(second.map((s) => s.seq)).toEqual([0, 1]);
    expect(first).toHaveLength(1);
  });

  it("completeStep：收尾最后一个 running 步骤，写入 summary", () => {
    let steps: FlowStep[] = beginStep([], { ...init, startedAt: NOW });
    steps = beginStep(steps, {
      role: "agent",
      agentId: "a1",
      conversationId: "c1",
      startedAt: NOW,
    });
    steps = completeStep(steps, { summary: "执行完成" });
    expect(steps[0]?.status).toBe("running");
    expect(steps[1]?.status).toBe("done");
    expect(steps[1]?.summary).toBe("执行完成");
    expect(steps[1]?.endedAt).toBeUndefined(); // 收尾时间由调用方落库时补
  });

  it("completeStep：无 running 步骤时幂等原样返回", () => {
    const steps = completeStep(beginStep([], { ...init, startedAt: NOW }), { summary: "x" });
    expect(completeStep(steps, { summary: "y" })).toEqual(steps);
  });

  it("completeStep：可标 failed", () => {
    let steps = beginStep([], { ...init, startedAt: NOW });
    steps = completeStep(steps, { status: "failed", summary: "分发失败" });
    expect(steps[0]?.status).toBe("failed");
  });
});
