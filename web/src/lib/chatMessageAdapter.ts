import type {
  AppendMessage,
  ThreadAssistantMessagePart,
  ThreadMessageLike,
} from "@assistant-ui/react";
import type { ChatMessage, TurnPart } from "../types";
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
    (value.type === "image" || value.type === "markdown" || value.type === "document")
  );
}

/** JSON 值/对象最小结构（对齐 assistant-ui ToolCallMessagePart.args 的 ReadonlyJSONObject） */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

/** 工具输入摘要 → args 对象（摘要可能被截断，解析失败回退 raw） */
function toToolArgs(inputPreview: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(inputPreview);
    if (isRecord(parsed) && !Array.isArray(parsed)) return parsed as JsonObject;
  } catch {
    // 截断/非 JSON → raw
  }
  return { raw: inputPreview };
}

/** 回合分片 → assistant-ui content part */
function toContentPart(part: TurnPart): ThreadAssistantMessagePart {
  if (part.kind === "text") return { type: "text" as const, text: part.text };
  if (part.kind === "thinking") return { type: "reasoning" as const, text: part.text };
  return {
    type: "tool-call" as const,
    toolCallId: part.toolUseId,
    toolName: part.tool,
    argsText: part.inputPreview,
    args: toToolArgs(part.inputPreview),
    result: part.outputPreview,
    isError: part.isError,
  };
}

export function toAssistantMessage(message: ChatMessage): ThreadMessageLike {
  const custom = {
    delivery: message.delivery ?? "accepted",
    files: message.files ?? [],
  };
  // 顶层 createdAt（Date）：assistant-ui 对 assistant 消息只在该字段落元信息
  const createdAt = message.createdAt ? new Date(message.createdAt) : undefined;

  if (message.role === "bot") {
    if (message.kind === "turn") {
      return {
        id: message.id,
        role: "assistant",
        content: (message.parts ?? []).map(toContentPart),
        status:
          message.state === "running"
            ? ({ type: "running" } as const)
            : ({ type: "complete", reason: "stop" } as const),
        createdAt,
        metadata: { custom },
      };
    }
    return {
      id: message.id,
      role: "assistant",
      content: message.text,
      status: { type: "complete", reason: "stop" },
      createdAt,
      metadata: { custom },
    };
  }

  return {
    id: message.id,
    role: "user",
    content: message.text,
    createdAt,
    metadata: { custom },
  };
}

export function getComposerPayload(message: AppendMessage): {
  text: string;
  files: FileInfo[];
} {
  if (message.role !== "user") {
    throw new Error("仅支持用户消息");
  }
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  const files = (message.attachments ?? []).flatMap((attachment) =>
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
