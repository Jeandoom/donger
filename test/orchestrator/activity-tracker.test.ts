import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "../../src/domain/types.js";
import { ActivityTracker } from "../../src/orchestrator/activity-tracker.js";

const CID = "conv-1";

function ev(e: Omit<Extract<RunnerEvent, { type: "tool_use" }>, "taskId">): RunnerEvent {
  return { ...e, taskId: "t1" } as RunnerEvent;
}

describe("ActivityTracker", () => {
  it("thinking → text → tool 状态推进，tool 携带工具名", () => {
    const t = new ActivityTracker();
    t.observe(CID, { type: "thinking_delta", taskId: "t1", messageId: "m", text: "…" });
    expect(t.get(CID)?.state).toBe("thinking");

    t.observe(CID, { type: "text_delta", taskId: "t1", messageId: "m", text: "好" });
    expect(t.get(CID)?.state).toBe("text");

    t.observe(
      CID,
      ev({ type: "tool_use", tool: "Bash", input: { command: "ls" }, toolUseId: "u1" }),
    );
    const tool = t.get(CID);
    expect(tool?.state).toBe("tool");
    expect(tool?.toolName).toBe("Bash");
    expect(tool?.toolUseId).toBe("u1");
  });

  it("tool_result 回落 thinking（模型处理结果中）", () => {
    const t = new ActivityTracker();
    t.observe(CID, { type: "tool_use", taskId: "t1", tool: "Read", input: {}, toolUseId: "u1" });
    t.observe(CID, {
      type: "tool_result",
      taskId: "t1",
      toolUseId: "u1",
      content: "x",
      isError: false,
    });
    expect(t.get(CID)?.state).toBe("thinking");
    expect(t.get(CID)?.toolName).toBeUndefined();
  });

  it("result 事件清除条目；审计类事件不改变状态", () => {
    const t = new ActivityTracker();
    t.observe(CID, { type: "text_delta", taskId: "t1", messageId: "m", text: "好" });
    t.observe(CID, { type: "llm_output", taskId: "t1", output: "{}" });
    expect(t.get(CID)?.state).toBe("text");
    t.observe(CID, { type: "result", taskId: "t1", subtype: "success", result: "完成" });
    expect(t.get(CID)).toBeUndefined();
  });

  it("end() 幂等清除（abort/异常路径兜底）", () => {
    const t = new ActivityTracker();
    t.observe(CID, { type: "text_delta", taskId: "t1", messageId: "m", text: "好" });
    t.end(CID);
    expect(t.get(CID)).toBeUndefined();
    expect(() => t.end(CID)).not.toThrow();
  });

  it("多会话互不串扰", () => {
    const t = new ActivityTracker();
    t.observe("a", { type: "thinking_delta", taskId: "t1", messageId: "m", text: "…" });
    t.observe("b", { type: "text_delta", taskId: "t2", messageId: "m", text: "好" });
    expect(t.get("a")?.state).toBe("thinking");
    expect(t.get("b")?.state).toBe("text");
  });
});
