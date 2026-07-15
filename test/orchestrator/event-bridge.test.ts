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
  const texts: string[] = [];
  const results: Array<{ subtype: "success" | "error"; text: string }> = [];
  return {
    id: "web",
    streaming: true,
    deltas,
    texts,
    results,
    onMessage: () => {},
    send: async () => {},
    pushText: (_conversationId: string, text: string) => texts.push(text),
    pushTextDelta: (_conversationId: string, messageId: string, text: string) =>
      deltas.push({ messageId, text }),
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

  it("session_init / tool_use 被忽略", async () => {
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
});
