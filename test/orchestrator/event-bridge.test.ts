import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "../../src/domain/types.js";
import { bridgeEvents } from "../../src/orchestrator/event-bridge.js";
import type { Channel, OutgoingMessage } from "../../src/ports/channel.js";

async function* of(events: RunnerEvent[]): AsyncIterable<RunnerEvent> {
  for (const e of events) yield e;
}

function fakeChannel(): Channel & { sent: OutgoingMessage[] } {
  const sent: OutgoingMessage[] = [];
  return {
    id: "test",
    sent,
    onMessage: () => {},
    send: async (_t, m) => {
      sent.push(m);
    },
    requestApproval: async () => ({ approved: true }),
  };
}

function fakeStreamingChannel() {
  const deltas: Array<{ messageId: string; text: string }> = [];
  const thinking: Array<{ messageId: string; text: string }> = [];
  const texts: string[] = [];
  const results: Array<{ subtype: "success" | "error"; text: string }> = [];
  const toolUses: Array<{ toolUseId: string; tool: string; inputPreview: string }> = [];
  const toolResults: Array<{ toolUseId: string; outputPreview: string; isError: boolean }> = [];
  const activities: string[] = [];
  return {
    id: "web",
    streaming: true,
    deltas,
    thinking,
    texts,
    results,
    toolUses,
    toolResults,
    activities,
    onMessage: () => {},
    send: async () => {},
    pushText: (_conversationId: string, text: string) => texts.push(text),
    pushTextDelta: (_conversationId: string, messageId: string, text: string) =>
      deltas.push({ messageId, text }),
    pushThinkingDelta: (_conversationId: string, messageId: string, text: string) =>
      thinking.push({ messageId, text }),
    pushToolUse: (
      _conversationId: string,
      event: { toolUseId: string; tool: string; inputPreview: string },
    ) => toolUses.push(event),
    pushToolResult: (
      _conversationId: string,
      event: { toolUseId: string; outputPreview: string; isError: boolean },
    ) => toolResults.push(event),
    pushActivity: (_conversationId: string, text: string) => activities.push(text),
    pushResult: (_conversationId: string, subtype: "success" | "error", text: string) =>
      results.push({ subtype, text }),
    requestApproval: async () => ({ approved: true }),
  };
}

describe("bridgeEvents", () => {
  it("Web 增量推流后不再重复推送完整 text，result 只通知完成", async () => {
    const ch = fakeStreamingChannel();
    await bridgeEvents(
      ch,
      "c1",
      of([
        { type: "text_delta", taskId: "t", messageId: "msg-1", text: "Hi" },
        { type: "text_delta", taskId: "t", messageId: "msg-1", text: "!" },
        { type: "text", taskId: "t", text: "Hi!" },
        { type: "result", taskId: "t", subtype: "success", result: "Hi!" },
      ]),
    );

    expect(ch.deltas).toEqual([
      { messageId: "msg-1", text: "Hi" },
      { messageId: "msg-1", text: "!" },
    ]);
    expect(ch.texts).toEqual([]);
    expect(ch.results).toEqual([{ subtype: "success", text: "Hi!" }]);
  });

  it("thinking_delta → pushThinkingDelta 透出，不入消息流", async () => {
    const ch = fakeStreamingChannel();
    await bridgeEvents(
      ch,
      "c1",
      of([
        { type: "thinking_delta", taskId: "t", messageId: "msg-1", text: "先分析…" },
        { type: "thinking_delta", taskId: "t", messageId: "msg-1", text: "再动手" },
        { type: "text_delta", taskId: "t", messageId: "msg-1", text: "答案" },
      ]),
    );
    expect(ch.thinking).toEqual([
      { messageId: "msg-1", text: "先分析…" },
      { messageId: "msg-1", text: "再动手" },
    ]);
    expect(ch.deltas).toEqual([{ messageId: "msg-1", text: "答案" }]);
    expect(ch.texts).toEqual([]);
  });

  it("tool_use/tool_result → 结构化事件推送（成败都推）+ activity 行为不变", async () => {
    const ch = fakeStreamingChannel();
    await bridgeEvents(
      ch,
      "c1",
      of([
        {
          type: "tool_use",
          taskId: "t",
          tool: "Bash",
          input: { command: "ls -la" },
          toolUseId: "tu-1",
        },
        { type: "tool_result", taskId: "t", toolUseId: "tu-1", content: "ok", isError: false },
        { type: "tool_result", taskId: "t", toolUseId: "tu-2", content: "boom", isError: true },
      ]),
    );
    expect(ch.toolUses).toEqual([
      { toolUseId: "tu-1", tool: "Bash", inputPreview: '{"command":"ls -la"}' },
    ]);
    expect(ch.toolResults).toEqual([
      { toolUseId: "tu-1", outputPreview: "ok", isError: false },
      { toolUseId: "tu-2", outputPreview: "boom", isError: true },
    ]);
  });

  it("tool_use 输入摘要超长截断（500）", async () => {
    const ch = fakeStreamingChannel();
    await bridgeEvents(
      ch,
      "c1",
      of([
        {
          type: "tool_use",
          taskId: "t",
          tool: "Write",
          input: { content: "x".repeat(2000) },
          toolUseId: "tu-1",
        },
      ]),
    );
    expect(ch.toolUses[0]?.inputPreview.length).toBeLessThanOrEqual(500);
  });

  it("text → 发文本", async () => {
    const ch = fakeChannel();
    await bridgeEvents(ch, "th", of([{ type: "text", taskId: "t", text: "hi" }]));
    expect(ch.sent.map((m) => m.text)).toEqual(["hi"]);
  });

  it("result success → 不发消息（agent 文本已是回复）", async () => {
    const ch = fakeChannel();
    await bridgeEvents(
      ch,
      "th",
      of([{ type: "result", taskId: "t", subtype: "success", result: "ok" }]),
    );
    expect(ch.sent).toEqual([]);
  });

  it("result error → ❌ 失败", async () => {
    const ch = fakeChannel();
    await bridgeEvents(
      ch,
      "th",
      of([{ type: "result", taskId: "t", subtype: "error", error: "崩了" }]),
    );
    expect(ch.sent[0]?.text).toBe("❌ 失败：崩了");
  });

  it("text 落库携带 taskId（回合归属）", async () => {
    const added: Array<{ role: string; text: string; taskId?: string }> = [];
    const store = {
      add: async (
        _conversationId: string,
        role: "user" | "bot",
        text: string,
        _files?: string,
        taskId?: string,
      ) => {
        added.push({ role, text, taskId });
        return {} as import("../../src/domain/types.js").StoredMessage;
      },
      listByConversation: async () => [],
    };
    const ch = fakeStreamingChannel();
    await bridgeEvents(ch, "c1", of([{ type: "text", taskId: "task-9", text: "Hi" }]), store);
    expect(added).toEqual([{ role: "bot", text: "Hi", taskId: "task-9" }]);
  });

  it("session_init 被忽略；非流式通道上 tool_use 无副作用", async () => {
    const ch = fakeChannel();
    await bridgeEvents(
      ch,
      "th",
      of([
        { type: "session_init", taskId: "t", sessionId: "s" },
        { type: "tool_use", taskId: "t", tool: "Bash", input: {}, toolUseId: "tu" },
      ]),
    );
    expect(ch.sent).toEqual([]);
  });

  it("完整流按顺序发", async () => {
    const ch = fakeChannel();
    await bridgeEvents(
      ch,
      "th",
      of([
        { type: "text", taskId: "t", text: "a" },
        { type: "text", taskId: "t", text: "b" },
        { type: "result", taskId: "t", subtype: "success", result: "done" },
      ]),
    );
    expect(ch.sent.map((m) => m.text)).toEqual(["a", "b"]);
  });

  it("内置工具协议调用头折叠为 activity，不落库不推送", async () => {
    const added: Array<{ role: string; text: string }> = [];
    const store = {
      add: async (_c: string, role: "user" | "bot", text: string) => {
        added.push({ role, text });
        return {} as import("../../src/domain/types.js").StoredMessage;
      },
      listByConversation: async () => [],
    };
    const ch = fakeStreamingChannel();
    await bridgeEvents(
      ch,
      "c1",
      of([
        {
          type: "text",
          taskId: "t",
          text: '**🌐 Z.ai Built-in Tool: analyze_image**\n\n**Input:**\n```json\n{"imageSource":"https://x/att.jpg?Signature=qON"}\n```',
        },
      ]),
      store,
    );
    expect(added).toEqual([]);
    expect(ch.activities).toEqual(["🌐 analyze_image（模型内置工具）执行中"]);
    expect(ch.texts).toEqual([]);
  });

  it("普通 text 落库/推送前脱敏预签名 URL 参数", async () => {
    const added: Array<{ role: string; text: string }> = [];
    const store = {
      add: async (_c: string, role: "user" | "bot", text: string) => {
        added.push({ role, text });
        return {} as import("../../src/domain/types.js").StoredMessage;
      },
      listByConversation: async () => [],
    };
    const ch = fakeStreamingChannel();
    await bridgeEvents(
      ch,
      "c1",
      of([
        {
          type: "text",
          taskId: "t",
          text: "分析完成，图片见 https://x/att.jpg?UCloudPublicKey=TOKEN_abc&Expires=1788499735&Signature=qON/QSTF",
        },
      ]),
      store,
    );
    expect(added.length).toBe(1);
    expect(added[0]?.text).toContain("UCloudPublicKey=****");
    expect(added[0]?.text).not.toContain("qON/QSTF");
    expect(ch.texts[0]).toBe(added[0]?.text);
  });
});
