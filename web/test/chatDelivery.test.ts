import { describe, expect, it } from "vitest";
import { chatReducer, initialChatState } from "../src/lib/chatReducer";

describe("chat message delivery", () => {
  it("adds an identified optimistic user message", () => {
    const state = chatReducer(initialChatState(), {
      type: "user_message",
      id: "local-1",
      text: "hello",
    });
    expect(state.messages[0]).toMatchObject({
      id: "local-1",
      role: "user",
      delivery: "sending",
    });
  });

  it("updates only the matching message delivery state", () => {
    const first = chatReducer(initialChatState(), {
      type: "user_message",
      id: "local-1",
      text: "one",
    });
    const second = chatReducer(first, {
      type: "message_delivery",
      id: "local-1",
      delivery: "failed",
    });
    expect(second.messages[0]?.delivery).toBe("failed");
  });
});
