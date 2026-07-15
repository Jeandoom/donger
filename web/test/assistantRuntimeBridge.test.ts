import type { AppendMessage } from "@assistant-ui/react";
import { describe, expect, it, vi } from "vitest";
import { createChatRuntimeAdapter } from "../src/lib/assistantRuntimeBridge";
import { DongerAttachmentAdapter } from "../src/lib/dongerAttachmentAdapter";

describe("createChatRuntimeAdapter", () => {
  it("forwards one Composer submission to the existing send function", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const adapter = createChatRuntimeAdapter({
      messages: [],
      loading: false,
      generating: true,
      send,
      attachmentAdapter: new DongerAttachmentAdapter(),
    });
    const message = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      attachments: [],
      metadata: { custom: {} },
      parentId: null,
      sourceId: null,
      runConfig: undefined,
    } satisfies AppendMessage;

    await adapter.onNew?.(message);
    expect(adapter.isRunning).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("hello", undefined);
  });
});
