import type { AuditEvent, RunnerEvent } from "./types.js";

type AuditableRunnerEvent = Exclude<RunnerEvent, { type: "text_delta" | "thinking_delta" }>;

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

/**
 * 凭证脱敏（纯函数，审计入库前统一过一遍）。
 * 背景（2026-09-12 复盘 P2-12）：jihulab token、TB userToken、Langfuse secret key
 * 曾以明文持久化在审计 toolInput/toolOutput/转写里（git remote -v 输出、clone 命令、
 * MCP URL query）。模式取自本周真实泄露样本；原则是保结构留诊断、值一律打码。
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // URL 内嵌凭证：https://oauth2:<token>@host、https://user:pass@host
  { pattern: /(https?:\/\/[^\s/@]+:)([^\s@/]{4})[^\s@/]*@/g, replacement: "$1****@" },
  // 已知 query 参数形态：userToken=…、access_token=…、token=…
  {
    pattern: /((?:user_?token|access_?token|api_?key|secret_?key|token)=)([^&\s"']{4})[^&\s"']*/gi,
    replacement: "$1****",
  },
  // 显式标注：access token[:：]值、PRIVATE-TOKEN: 值、Bearer 值
  {
    pattern:
      /((?:access[ _]?token|private-token|bearer)[:=]\s*)([A-Za-z0-9._~+/=-]{4})[A-Za-z0-9._~+/=-]*/gi,
    replacement: "$1****",
  },
  // Langfuse 风格密钥字面量：pk-lf-… / sk-lf-…
  { pattern: /\b(pk|sk)-[a-z0-9-]{6,}/gi, replacement: "$1-****" },
  // 云存储预签名 URL 参数（UCloud/AWS 系）：Signature/有效期随模型输出落库属敏感泄露
  // （实测样本：analyze_image 内置工具输出含 ?UCloudPublicKey=…&Expires=…&Signature=…）
  {
    pattern: /((?:UCloudPublicKey|Signature|Expires|X-Amz-[A-Za-z-]+)=)[^&\s"'\\]+/g,
    replacement: "$1****",
  },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

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
    case "llm_input":
      return { ...base, type: "llm_input", llmInput: redactSecrets(e.input) };
    case "llm_output":
      return { ...base, type: "llm_output", llmOutput: redactSecrets(e.output) };
    case "text":
      return { ...base, type: "text", text: redactSecrets(e.text) };
    case "tool_use":
      return {
        ...base,
        type: "tool_use",
        toolName: e.tool,
        toolInput: truncate(redactSecrets(JSON.stringify(e.input))),
        toolUseId: e.toolUseId,
      };
    case "tool_result":
      return {
        ...base,
        type: "tool_result",
        toolUseId: e.toolUseId,
        toolOutput: truncate(redactSecrets(e.content)),
        isError: e.isError,
        durationMs: extra.durationMs,
      };
    case "result":
      return {
        ...base,
        type: "result",
        resultSubtype: e.subtype,
        text: redactSecrets(e.result ?? e.error ?? ""),
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
    text: redactSecrets(prompt),
  };
}
