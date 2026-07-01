import { describe, expect, it } from "vitest";
import { AUDIT_TRUNCATE_LIMIT, toAuditEvent, userMessageAudit } from "../../src/domain/audit.js";

const ctx = {
  conversationId: "c1",
  userId: "u1",
  taskId: "t1",
  seq: 5,
  recordedAt: "2026-07-01T00:00:00.000Z",
};

describe("toAuditEvent", () => {
  it("text → 完整文本不截断", () => {
    const e = toAuditEvent({ type: "text", taskId: "t1", text: "你好" }, ctx);
    expect(e).toMatchObject({ type: "text", text: "你好", conversationId: "c1", seq: 5 });
  });

  it("tool_use → toolInput 为 JSON 串", () => {
    const e = toAuditEvent(
      { type: "tool_use", taskId: "t1", tool: "Bash", input: { command: "ls" }, toolUseId: "tu1" },
      ctx,
    );
    expect(e).toMatchObject({ type: "tool_use", toolName: "Bash", toolUseId: "tu1" });
    expect(e.toolInput).toBe('{"command":"ls"}');
  });

  it("tool_use.toolInput 超 4096 截断", () => {
    const big = "x".repeat(AUDIT_TRUNCATE_LIMIT + 100);
    const e = toAuditEvent(
      { type: "tool_use", taskId: "t1", tool: "Write", input: { content: big }, toolUseId: "tu" },
      ctx,
    );
    expect(e.toolInput?.length).toBe(AUDIT_TRUNCATE_LIMIT);
  });

  it("tool_result → output 截断 + 挂 durationMs", () => {
    const e = toAuditEvent(
      { type: "tool_result", taskId: "t1", toolUseId: "tu1", content: "ok", isError: false },
      ctx,
      { durationMs: 42 },
    );
    expect(e).toMatchObject({
      type: "tool_result",
      toolOutput: "ok",
      isError: false,
      durationMs: 42,
    });
  });

  it("result → usage + model + durationMs", () => {
    const e = toAuditEvent(
      {
        type: "result",
        taskId: "t1",
        subtype: "success",
        result: "done",
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 4,
        },
      },
      ctx,
      { durationMs: 1000, model: "glm-5.1" },
    );
    expect(e).toMatchObject({
      type: "result",
      resultSubtype: "success",
      model: "glm-5.1",
      durationMs: 1000,
    });
    expect(e.usage?.inputTokens).toBe(1);
    expect(e.text).toBe("done");
  });

  it("result error → text 取 error", () => {
    const e = toAuditEvent({ type: "result", taskId: "t1", subtype: "error", error: "爆了" }, ctx);
    expect(e.text).toBe("爆了");
    expect(e.resultSubtype).toBe("error");
  });

  it("session_init → 仅上下文", () => {
    const e = toAuditEvent({ type: "session_init", taskId: "t1", sessionId: "s1" }, ctx);
    expect(e).toMatchObject({ type: "session_init", conversationId: "c1" });
  });
});

describe("userMessageAudit", () => {
  it("生成 user_message 事件，prompt 完整不截断", () => {
    const e = userMessageAudit("帮我修 bug", ctx);
    expect(e).toMatchObject({ type: "user_message", text: "帮我修 bug", seq: 5 });
  });
});
