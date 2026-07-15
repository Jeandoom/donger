import type { AuditEvent, RunnerEvent } from "./types.js";

type AuditableRunnerEvent = Exclude<RunnerEvent, { type: "text_delta" }>;

/** 审计 IO 截断上限（toolInput / toolOutput）；agent 文本与 prompt 不截断。 */
export const AUDIT_TRUNCATE_LIMIT = 4096;

function truncate(s: string): string {
  return s.length > AUDIT_TRUNCATE_LIMIT ? s.slice(0, AUDIT_TRUNCATE_LIMIT) : s;
}

type AuditCtx = {
  conversationId: string;
  userId: string;
  taskId: string;
  seq: number;
  recordedAt: string;
};

/** 把一条 RunnerEvent 映射成待持久化的 AuditEvent（不含 id，由 store 生成）。 */
export function toAuditEvent(
  e: AuditableRunnerEvent,
  ctx: AuditCtx,
  extra: { durationMs?: number; model?: string } = {},
): Omit<AuditEvent, "id"> {
  const base = {
    conversationId: ctx.conversationId,
    taskId: ctx.taskId,
    userId: ctx.userId,
    seq: ctx.seq,
    recordedAt: ctx.recordedAt,
  };
  switch (e.type) {
    case "session_init":
      return { ...base, type: "session_init" };
    case "text":
      return { ...base, type: "text", text: e.text };
    case "tool_use":
      return {
        ...base,
        type: "tool_use",
        toolName: e.tool,
        toolInput: truncate(JSON.stringify(e.input)),
        toolUseId: e.toolUseId,
      };
    case "tool_result":
      return {
        ...base,
        type: "tool_result",
        toolUseId: e.toolUseId,
        toolOutput: truncate(e.content),
        isError: e.isError,
        durationMs: extra.durationMs,
      };
    case "result":
      return {
        ...base,
        type: "result",
        resultSubtype: e.subtype,
        text: e.result ?? e.error,
        usage: e.usage,
        model: extra.model,
        durationMs: extra.durationMs,
      };
  }
}

/** 生成 user_message 审计事件（取自 task.prompt；非 RunnerEvent，不入流，仅审计）。 */
export function userMessageAudit(prompt: string, ctx: AuditCtx): Omit<AuditEvent, "id"> {
  return {
    conversationId: ctx.conversationId,
    taskId: ctx.taskId,
    userId: ctx.userId,
    seq: ctx.seq,
    recordedAt: ctx.recordedAt,
    type: "user_message",
    text: prompt,
  };
}
