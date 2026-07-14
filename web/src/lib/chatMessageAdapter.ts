import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react";
import type { ChatMessage } from "../types";
import type { FileInfo } from "./chatReducer";

type UnknownRecord = Record<string, unknown>;

export const MAX_MESSAGE_ATTACHMENTS = 5;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function isFileInfo(value: unknown): value is FileInfo {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === "string" &&
    typeof value.name === "string" &&
    (value.type === "image" || value.type === "markdown")
  );
}

export function toAssistantMessage(message: ChatMessage): ThreadMessageLike {
  const custom = {
    delivery: message.delivery ?? "accepted",
    files: message.files ?? [],
  };

  if (message.role === "bot") {
    return {
      id: message.id,
      role: "assistant",
      content: message.text,
      status: { type: "complete", reason: "stop" },
      metadata: { custom },
    };
  }

  return {
    id: message.id,
    role: "user",
    content: message.text,
    metadata: { custom },
  };
}

export function getComposerPayload(message: AppendMessage): {
  text: string;
  files: FileInfo[];
} {
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  const files = message.attachments.flatMap((attachment) =>
    attachment.content.flatMap((part) => {
      if (part.type !== "data" || part.name !== "donger-file") return [];
      return isFileInfo(part.data) ? [part.data] : [];
    }),
  );
  if (files.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new Error(`最多上传 ${MAX_MESSAGE_ATTACHMENTS} 个文件`);
  }
  return { text, files };
}
