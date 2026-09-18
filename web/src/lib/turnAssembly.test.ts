import { describe, expect, it } from "vitest";
import { assembleTurnMessages, type HistoryEvent, type HistoryMessage } from "./turnAssembly";

function msg(
  id: string,
  role: "user" | "bot",
  text: string,
  createdAt: string,
  taskId?: string,
): HistoryMessage {
  return { id, role, text, createdAt, ...(taskId ? { taskId } : {}) };
}

function toolUse(
  toolUseId: string,
  taskId: string,
  recordedAt: string,
  tool = "Bash",
  input = '{"command":"ls"}',
): HistoryEvent {
  return { type: "tool_use", taskId, toolName: tool, toolUseId, toolInput: input, recordedAt };
}

function toolResult(
  toolUseId: string,
  taskId: string,
  recordedAt: string,
  output = "ok",
  isError = false,
): HistoryEvent {
  return {
    type: "tool_result",
    taskId,
    toolUseId,
    toolOutput: output,
    isError,
    recordedAt,
  };
}

describe("assembleTurnMessages", () => {
  it("相邻 bot 消息合并为一个回合，用户消息切分回合", () => {
    const out = assembleTurnMessages(
      [
        msg("u1", "user", "问", "2026-09-14T10:00:00Z"),
        msg("b1", "bot", "答1", "2026-09-14T10:00:01Z"),
        msg("b2", "bot", "答2", "2026-09-14T10:00:02Z"),
        msg("u2", "user", "再问", "2026-09-14T10:01:00Z"),
        msg("b3", "bot", "答3", "2026-09-14T10:01:01Z"),
      ],
      [],
    );
    expect(out.map((m) => m.role)).toEqual(["user", "bot", "user", "bot"]);
    expect(out[1]?.kind).toBe("turn");
    expect(out[1]?.parts?.filter((p) => p.kind === "text").map((p) => p.text)).toEqual([
      "答1",
      "答2",
    ]);
    expect(out[3]?.parts?.length).toBe(1);
  });

  it("工具事件按时间线插入：文本前的工具在前，tool_result 回填", () => {
    const out = assembleTurnMessages(
      [
        msg("u1", "user", "问", "2026-09-14T10:00:00Z"),
        msg("b1", "bot", "答", "2026-09-14T10:00:05Z", "t1"),
      ],
      [
        toolUse("tu1", "t1", "2026-09-14T10:00:01Z"),
        toolResult("tu1", "t1", "2026-09-14T10:00:03Z", "文件列表", false),
      ],
    );
    const parts = out[1]?.parts ?? [];
    expect(parts.map((p) => p.kind)).toEqual(["tool", "text"]);
    const tool = parts[0];
    if (tool?.kind !== "tool") throw new Error("expected tool part");
    expect(tool.tool).toBe("Bash");
    expect(tool.state).toBe("done");
    expect(tool.outputPreview).toBe("文件列表");
    expect(tool.isError).toBe(false);
  });

  it("无 taskId 的旧消息仅合并不装饰", () => {
    const out = assembleTurnMessages(
      [
        msg("u1", "user", "问", "2026-09-14T10:00:00Z"),
        msg("b1", "bot", "答1", "2026-09-14T10:00:01Z"),
        msg("b2", "bot", "答2", "2026-09-14T10:00:02Z"),
      ],
      [toolUse("tu1", "t9", "2026-09-14T10:00:01Z")],
    );
    expect(out[1]?.kind).toBe("turn");
    expect(out[1]?.parts?.every((p) => p.kind === "text")).toBe(true);
  });

  it("同一回合跨多个 task：各自 taskId 的事件都能装饰", () => {
    const out = assembleTurnMessages(
      [
        msg("u1", "user", "问", "2026-09-14T10:00:00Z"),
        msg("b1", "bot", "第一次尝试", "2026-09-14T10:00:01Z", "t1"),
        msg("b2", "bot", "重试后成功", "2026-09-14T10:02:00Z", "t2"),
      ],
      [
        toolUse("tu1", "t1", "2026-09-14T10:00:02Z", "Bash", '{"command":"deploy"}'),
        toolResult("tu1", "t1", "2026-09-14T10:00:03Z", "失败", true),
        toolUse("tu2", "t2", "2026-09-14T10:01:00Z", "Read"),
        toolResult("tu2", "t2", "2026-09-14T10:01:30Z", "{}"),
      ],
    );
    const tools = (out[1]?.parts ?? []).filter((p) => p.kind === "tool");
    expect(tools.length).toBe(2);
    expect((tools[0] as Extract<(typeof tools)[0], { kind: "tool" }>).state).toBe("error");
    expect((tools[1] as Extract<(typeof tools)[1], { kind: "tool" }>).state).toBe("done");
  });

  it("tool_use 无对应 tool_result：收口标记为 error（中断）", () => {
    const out = assembleTurnMessages(
      [
        msg("u1", "user", "问", "2026-09-14T10:00:00Z"),
        msg("b1", "bot", "答", "2026-09-14T10:00:05Z", "t1"),
      ],
      [toolUse("tu1", "t1", "2026-09-14T10:00:01Z")],
    );
    const tool = (out[1]?.parts ?? [])[0];
    if (tool?.kind !== "tool") throw new Error("expected tool part");
    expect(tool.state).toBe("error");
    expect(tool.outputPreview).toContain("中断");
  });

  it("最后一条消息之后发生的工具事件也入时间线", () => {
    const out = assembleTurnMessages(
      [
        msg("u1", "user", "问", "2026-09-14T10:00:00Z"),
        msg("b1", "bot", "答", "2026-09-14T10:00:01Z", "t1"),
      ],
      [
        toolUse("tu1", "t1", "2026-09-14T10:00:02Z", "Write"),
        toolResult("tu1", "t1", "2026-09-14T10:00:04Z", "written"),
      ],
    );
    expect((out[1]?.parts ?? []).map((p) => p.kind)).toEqual(["text", "tool"]);
  });
});
