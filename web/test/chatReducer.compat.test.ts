import { afterEach, describe, expect, it, vi } from "vitest";
import { chatReducer, initialChatState } from "../src/lib/chatReducer";

describe("chatReducer ID compatibility", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates unique message IDs when randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});

    const first = chatReducer(initialChatState(), { type: "user_message", text: "hello" });
    const second = chatReducer(first, { type: "ws", msg: { type: "text", text: "hi" } });

    expect(second.messages).toHaveLength(2);
    expect(second.messages[0]?.id).toMatch(/^local-/);
    expect(second.messages[1]?.id).toMatch(/^local-/);
    expect(second.messages[0]?.id).not.toBe(second.messages[1]?.id);
  });
});
