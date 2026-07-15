import { describe, expect, it } from "vitest";
import { chatReducer, initialChatState } from "../src/lib/chatReducer";

describe("chat streaming", () => {
  it("aggregates text deltas into one assistant message and result does not duplicate it", () => {
    const sent = chatReducer(initialChatState(), {
      type: "user_message",
      id: "user-1",
      text: "hi",
    });
    const first = chatReducer(sent, {
      type: "ws",
      msg: { type: "text_delta", messageId: "assistant-1", text: "Hi" },
    });
    const second = chatReducer(first, {
      type: "ws",
      msg: { type: "text_delta", messageId: "assistant-1", text: "!" },
    });
    const completed = chatReducer(second, {
      type: "ws",
      msg: { type: "result", subtype: "success", text: "Hi!" },
    });

    expect(second.messages).toHaveLength(2);
    expect(second.messages[1]).toMatchObject({
      id: "assistant-1",
      role: "bot",
      text: "Hi!",
    });
    expect(second.isGenerating).toBe(true);
    expect(completed.messages).toEqual(second.messages);
    expect(completed.isGenerating).toBe(false);
  });

  it("ignores the empty SSE connection acknowledgement", () => {
    const state = chatReducer(initialChatState(), {
      type: "ws",
      msg: { type: "text", text: "" },
    });

    expect(state.messages).toEqual([]);
  });

  it("does not create an empty assistant row for a leading whitespace delta", () => {
    const state = chatReducer(initialChatState(), {
      type: "ws",
      msg: { type: "text_delta", messageId: "assistant-1", text: "\n" },
    });

    expect(state.messages).toEqual([]);
    expect(state.isGenerating).toBe(true);
  });

  it("stops the generating state when the SSE stream reports an error", () => {
    const running = chatReducer(initialChatState(), {
      type: "generation",
      running: true,
    });
    const failed = chatReducer(running, {
      type: "ws",
      msg: { type: "error", error: "生成失败" },
    });

    expect(failed.isGenerating).toBe(false);
    expect(failed.errors.stream).toBe("生成失败");
  });
});
