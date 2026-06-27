import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "../../src/domain/types.js";
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
});
