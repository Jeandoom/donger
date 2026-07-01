import { describe, expect, it } from "vitest";
import type { AuditEvent, RunnerEvent } from "../../src/domain/types.js";
import { IncomingMessageSchema, TaskSchema } from "../../src/domain/types.js";

const validTask = {
  id: "t1",
  channelId: "cli",
  threadId: "th",
  requesterId: "u",
  prompt: "hi",
  status: "created",
  skillChain: [],
  createdAt: "t",
  updatedAt: "t",
};

describe("TaskSchema", () => {
  it("接受合法 Task（可选项缺省）", () => {
    const t = TaskSchema.parse(validTask);
    expect(t.id).toBe("t1");
    expect(t.cwd).toBeUndefined();
    expect(t.error).toBeUndefined();
  });

  it("接受可选字段 cwd / error", () => {
    const t = TaskSchema.parse({ ...validTask, cwd: "/worktree", error: "boom" });
    expect(t.cwd).toBe("/worktree");
    expect(t.error).toBe("boom");
  });

  it("拒绝非法 status", () => {
    expect(() => TaskSchema.parse({ ...validTask, status: "nope" })).toThrow();
  });

  it("拒绝缺必填字段", () => {
    expect(() => TaskSchema.parse({ id: "t1" })).toThrow();
  });
});

describe("IncomingMessageSchema", () => {
  it("接受合法消息", () => {
    const m = IncomingMessageSchema.parse({
      channelId: "dingtalk",
      threadId: "th",
      requesterId: "u1",
      text: "加个接口",
    });
    expect(m.text).toBe("加个接口");
  });

  it("拒绝缺 text 字段", () => {
    expect(() =>
      IncomingMessageSchema.parse({ channelId: "cli", threadId: "th", requesterId: "u" }),
    ).toThrow();
  });
});

describe("RunnerEvent 判别联合", () => {
  it("按 type 收窄到 text", () => {
    const e: RunnerEvent = { type: "text", taskId: "t", text: "hi" };
    if (e.type === "text") {
      expect(e.text).toBe("hi");
    }
  });

  it("result 按 subtype 分支", () => {
    const ok: RunnerEvent = { type: "result", taskId: "t", subtype: "success", result: "done" };
    const err: RunnerEvent = { type: "result", taskId: "t", subtype: "error", error: "boom" };
    if (ok.type === "result" && ok.subtype === "success") {
      expect(ok.result).toBe("done");
    }
    if (err.type === "result" && err.subtype === "error") {
      expect(err.error).toBe("boom");
    }
  });

  it("result 可携带 usage（模型无关，四项）", () => {
    const e: RunnerEvent = {
      type: "result",
      taskId: "t",
      subtype: "success",
      result: "done",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 1,
      },
    };
    if (e.type === "result" && e.usage) {
      expect(e.usage.inputTokens).toBe(10);
      expect(e.usage.cacheReadInputTokens).toBe(1);
    }
  });

  it("result 的 usage 可缺省", () => {
    const e: RunnerEvent = { type: "result", taskId: "t", subtype: "success", result: "done" };
    if (e.type === "result") {
      expect(e.usage).toBeUndefined();
    }
  });

  it("tool_result 变体：toolUseId + content + isError", () => {
    const e: RunnerEvent = {
      type: "tool_result",
      taskId: "t",
      toolUseId: "tu1",
      content: "done",
      isError: false,
    };
    if (e.type === "tool_result") {
      expect(e.toolUseId).toBe("tu1");
      expect(e.isError).toBe(false);
    }
  });
});

describe("AuditEvent", () => {
  it("result 事件携带 model + usage + durationMs", () => {
    const e: AuditEvent = {
      id: "a1",
      conversationId: "c1",
      taskId: "t1",
      userId: "u1",
      seq: 3,
      type: "result",
      resultSubtype: "success",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 4,
      },
      model: "glm-5.1",
      durationMs: 1200,
      recordedAt: "2026-07-01T00:00:00.000Z",
    };
    expect(e.model).toBe("glm-5.1");
    expect(e.durationMs).toBe(1200);
  });

  it("tool_use 事件带 toolInput/toolUseId", () => {
    const e: AuditEvent = {
      id: "a2",
      conversationId: "c1",
      taskId: "t1",
      userId: "u1",
      seq: 1,
      type: "tool_use",
      toolName: "Bash",
      toolInput: '{"command":"ls"}',
      toolUseId: "tu1",
      recordedAt: "t",
    };
    expect(e.toolName).toBe("Bash");
  });
});
