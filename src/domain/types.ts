// 领域数据形状（纯数据，不含行为/接口）。后续所有任务共享的词汇表。
// IO 边界（持久化、外部输入）用 Zod 做运行时校验；内部传递类型用纯 TS。
import { z } from "zod";

// === Task ===
export const TaskStatusEnum = z.enum([
  "created",
  "planning",
  "running",
  "awaiting_approval",
  "awaiting_credentials",
  "done",
  "failed",
  "canceled",
]);
export type TaskStatus = z.infer<typeof TaskStatusEnum>;

export const TaskSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  threadId: z.string(),
  requesterId: z.string(),
  prompt: z.string(),
  status: TaskStatusEnum,
  skillChain: z.array(z.string()),
  cwd: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

// === Skill ===
export type SkillKind = "markdown" | "code";
export interface Skill {
  id: string;
  kind: SkillKind;
  description: string;
  triggers?: string[];
  /** 该 skill 执行完后触发的审批门 id（如 design→"design"） */
  gateAfter?: string;
}

// === Gate ===
export interface Gate {
  id: string;
  description: string;
}

// === Token 用量（模型无关；四项之和 = total，由 store 计算后存入 UsageRecord）===
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

// === Runner 事件（AgentRunner 产出的判别联合）===
export type RunnerEvent =
  | { type: "session_init"; taskId: string; sessionId: string }
  | { type: "text_delta"; taskId: string; messageId: string; text: string }
  | { type: "text"; taskId: string; text: string }
  | {
      type: "tool_use";
      taskId: string;
      tool: string;
      input: Record<string, unknown>;
      toolUseId: string;
    }
  | {
      type: "tool_result";
      taskId: string;
      toolUseId: string;
      content: string;
      isError: boolean;
    }
  | {
      type: "result";
      taskId: string;
      subtype: "success" | "error";
      result?: string;
      error?: string;
      usage?: TokenUsage;
    };

// === 审计事件（持久化后的 RunnerEvent + 上下文；按 conversationId+taskId+seq 关联）===
export interface AuditEvent {
  id: string;
  conversationId: string;
  taskId: string;
  userId: string;
  seq: number;
  type: "user_message" | "session_init" | "text" | "tool_use" | "tool_result" | "result";
  text?: string;
  toolName?: string;
  toolInput?: string;
  toolUseId?: string;
  toolOutput?: string;
  isError?: boolean;
  resultSubtype?: "success" | "error";
  usage?: TokenUsage;
  /** 仅 result 带；为后续按 LLM 结算备料 */
  model?: string;
  /** tool_result=该工具耗时；result=该轮总耗时 */
  durationMs?: number;
  recordedAt: string;
}

// === 消息（Channel 入/出）===
export const MessageFileSchema = z.object({
  path: z.string(),
  name: z.string(),
  type: z.enum(["image", "markdown"]),
});
export type MessageFile = z.infer<typeof MessageFileSchema>;

export const IncomingMessageSchema = z.object({
  channelId: z.string(),
  threadId: z.string(),
  requesterId: z.string(),
  text: z.string(),
  conversationId: z.string().optional(),
  files: z.array(MessageFileSchema).optional(),
});
export type IncomingMessage = z.infer<typeof IncomingMessageSchema>;

export interface OutgoingMessage {
  text: string;
  markdown?: boolean;
}

// === 持久化聊天消息 ===
export interface StoredMessage {
  id: string;
  conversationId: string;
  role: "user" | "bot";
  text: string;
  /** files 字段 JSON stringified，空数组存 "[]" */
  files: string;
  createdAt: string;
}

// === 审批 ===
export interface ApprovalCard {
  gateId: string;
  title: string;
  summary: string;
}

/** 命中门时由 runner 传给 Orchestrator 的审批请求（数据形状；resolver 函数类型在 ports 定义） */
export interface ApprovalRequest {
  taskId: string;
  gateId: string;
  tool: string;
  toolUseId: string;
  input: Record<string, unknown>;
  summary: string;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}
