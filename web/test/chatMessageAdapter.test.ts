import type { AppendMessage } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_ATTACHMENTS,
  getComposerPayload,
  toAssistantMessage,
} from "../src/lib/chatMessageAdapter";
import type { ChatMessage } from "../src/types";

describe("chatMessageAdapter", () => {
  it("maps bot messages to completed assistant messages", () => {
    const source: ChatMessage = { id: "m1", role: "bot", text: "**完成**" };

    expect(toAssistantMessage(source)).toEqual({
      id: "m1",
      role: "assistant",
      content: "**完成**",
      status: { type: "complete", reason: "stop" },
      metadata: { custom: { delivery: "accepted", files: [] } },
    });
  });

  it("keeps user attachment metadata outside model text", () => {
    const source: ChatMessage = {
      id: "m2",
      role: "user",
      text: "查看附件",
      files: [{ path: "/sessions/u/a.png", name: "a.png", type: "image" }],
      delivery: "sending",
    };

    const converted = toAssistantMessage(source);
    expect(converted.role).toBe("user");
    expect(converted.metadata?.custom).toEqual({
      delivery: "sending",
      files: source.files,
    });
  });

  it("extracts text and uploaded file metadata from Composer messages", () => {
    const message = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      attachments: [
        {
          id: "a1",
          type: "image",
          name: "a.png",
          status: { type: "complete" },
          content: [
            {
              type: "data",
              name: "donger-file",
              data: { path: "/sessions/u/a.png", name: "a.png", type: "image" },
            },
          ],
        },
      ],
      metadata: { custom: {} },
      parentId: null,
      sourceId: null,
      runConfig: undefined,
    } satisfies AppendMessage;

    expect(getComposerPayload(message)).toEqual({
      text: "hello",
      files: [{ path: "/sessions/u/a.png", name: "a.png", type: "image" }],
    });
  });

  it("rejects more than the existing five-attachment limit", () => {
    const message = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      attachments: Array.from({ length: MAX_MESSAGE_ATTACHMENTS + 1 }, (_, index) => ({
        id: `a${index}`,
        type: "image" as const,
        name: `${index}.png`,
        status: { type: "complete" as const },
        content: [
          {
            type: "data" as const,
            name: "donger-file",
            data: {
              path: `/sessions/u/${index}.png`,
              name: `${index}.png`,
              type: "image" as const,
            },
          },
        ],
      })),
      metadata: { custom: {} },
      parentId: null,
      sourceId: null,
      runConfig: undefined,
    } satisfies AppendMessage;

    expect(() => getComposerPayload(message)).toThrow("最多上传 5 个文件");
  });

  it("rejects non-user runtime messages before reading attachments", () => {
    const message = {
      role: "system",
      content: [{ type: "text", text: "system" }],
      metadata: { custom: {} },
      parentId: null,
      sourceId: null,
      runConfig: undefined,
    } satisfies AppendMessage;

    expect(() => getComposerPayload(message)).toThrow("仅支持用户消息");
  });

  it("treats omitted user attachments as an empty list", () => {
    const message = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      metadata: { custom: {} },
      parentId: null,
      sourceId: null,
      runConfig: undefined,
    } satisfies AppendMessage;

    expect(getComposerPayload(message)).toEqual({ text: "hello", files: [] });
  });
});
