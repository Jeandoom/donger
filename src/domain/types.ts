// 领域数据形状（纯数据，不含行为/接口）。后续所有任务共享的词汇表。
// IO 边界（持久化、外部输入）用 Zod 做运行时校验；内部传递类型用纯 TS。
import { z } from "zod";
import { ResolvedMentionSchema } from "./mentions.js";
import { AgentPermissionModeSchema } from "./permission-mode.js";
import { FlowStepSchema } from "./task-flow.js";

// === Task ===
export const TaskStatusEnum = z.enum([
  "created",
  "planning",
  "running",
  "awaiting_approval",
  "awaiting_credentials",
  /** 排水超时/崩溃被暂停（热发布 M2，spec 2026-10-16-hot-deploy-design）：非终态，恢复服务自动续跑 */
  "interrupted",
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
  // —— 多 agent 任务平台（P1）——
  /** dispatcher 路由或显式指定的执行 agent */
  agentId: z.string().optional(),
  /** dispatcher 路由理由（观测/优化用） */
  routingRationale: z.string().optional(),
  // —— 人工门挂起态（观测 + 重启清扫依据；决议/提交后清除）——
  /** 任务正卡在工具审批门时写入（仅 gateId/title/requestedAt；决议在内存 resolver，随进程丢失） */
  pendingGate: z
    .object({
      gateId: z.string(),
      title: z.string(),
      requestedAt: z.string(),
    })
    .optional(),
  /** 任务正卡在凭证缺失问询时写入（missingCodes = agent 勾选但当前用户未配置的 code） */
  pendingCredentials: z
    .object({ requestedAt: z.string(), missingCodes: z.array(z.string()).optional() })
    .optional(),
  /** Task Flow 流水线：dispatcher/builder/chat/agent 步骤链（请求级，方案 A 挂用户当前会话） */
  steps: z.array(FlowStepSchema).optional(),
  /** builder 完成自动重派产生本 task 时，指回触发补建的原 task */
  builderFromTaskId: z.string().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

// === Skill ===
export type SkillKind = "markdown" | "code";
export interface Skill {
  id: string;
  kind: "markdown" | "code";
  description: string;
  triggers?: string[];
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
  | { type: "llm_input"; taskId: string; input: string }
  | { type: "llm_output"; taskId: string; output: string }
  | { type: "text_delta"; taskId: string; messageId: string; text: string }
  | { type: "thinking_delta"; taskId: string; messageId: string; text: string }
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
  type:
    | "user_message"
    | "session_init"
    | "llm_input"
    | "llm_output"
    | "text"
    | "tool_use"
    | "tool_result"
    | "result"
    /** 凭证缺失问询（text=人读提示；toolInput=JSON {codes:[{code,name,keys}]}，不含值） */
    /** 凭证缺失问询（text=人读提示；toolInput=JSON {codes:[{code,name,keys}]}，不含值） */
    | "credential_prompt"
    /** 执行前准备失败（仓库物化/平台工具装配等；text=失败原因。复盘 P2-12：此前零审计痕迹） */
    | "prepare_error"
    /** 会话权限模式切换（text=人读描述；toolInput=JSON {from,to}） */
    | "permission_mode_change"
    /** 知识库自动学习失败（seq=-1 执行外事件；text=失败原因，静默不扰用户） */
    | "kb_auto_learn_error"
    /** 技能修订建议（知识体系轮 P3 萃取 skillSuggestion 路由；seq=-1 执行外事件；
     *  text=摘要，toolInput=JSON {targetSkill,diff,rationale,evidence,status:"pending"}。
     *  采纳走人审链路（P4），不直接改技能） */
    | "skill_suggestion"
    /** 技能晋升（知识体系轮 P4：萃取建议采纳落盘；seq=-1 执行外事件；text=晋升摘要） */
    | "skill_promoted"
    /** 主机命令策略裁决打标（seq=-1 执行外事件；specs/2026-10-12-host-exec-policy-design.md §6；
     *  text=裁决摘要，toolInput=命令前 300 字符。allow/deny/一键成策略落此；ask 有审批卡可见） */
    | "policy_decision"
    /** 风险不变量命中但被 full_access 零拦截放行（seq=-1 执行外事件；2026-10-13 权限模式轮；
     *  text=INV 判定原因，toolInput=调用摘要。零拦截≠零记录——事后追责/复盘凭此行） */
    | "inv_bypass"
    /** zcode 轮末对账标记（specs/2026-09-29-zcode-record-fidelity-design.md M1；
     *  text=补录统计 JSON。幂等键：同 taskId 再对账时发现此行即整体跳过） */
    | "zcode_reconcile"
    /** 审批决议落痕（热发布 M3，spec 2026-10-16-hot-deploy-design §6.2；seq=-1 执行外事件；
     *  text=决议摘要，toolInput=JSON {gateId,approved,reason?,responderId?}。
     *  此前批/拒动作完全无痕，M3 补全合规留痕） */
    | "approval_decision";
  text?: string;
  /** 完整的、已移除密钥的 Agent SDK query 输入。 */
  llmInput?: string;
  /** 完整的 Agent SDK 原始输出消息。 */
  llmOutput?: string;
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
  /** image/markdown 前端内联渲染提示；document=任意其余类型（下载链接） */
  type: z.enum(["image", "markdown", "document"]),
});
export type MessageFile = z.infer<typeof MessageFileSchema>;

export const IncomingMessageSchema = z.object({
  channelId: z.string(),
  threadId: z.string(),
  requesterId: z.string(),
  text: z.string(),
  conversationId: z.string().optional(),
  files: z.array(MessageFileSchema).optional(),
  /** Web 渠道：@/​/$/% 引用（服务端已校验解析；仅发送时注入 prompt，不落库）。
   *  上送侧限 20（MentionInputSchema）；此处是解析后形态，「全部会话」可展开超 20 条 */
  mentions: z.array(ResolvedMentionSchema).max(200).optional(),
  /** Web 渠道：用户在对话底栏显式选择的 LLM（modelRef；system|preset:x|provider:id:model） */
  modelRef: z.string().optional(),
  /** 系统内部：builder 完成后的自动重派消息（task 串联：builderFromTaskId 指回补建触发的 task） */
  builderFromTaskId: z.string().optional(),
  /**
   * 系统内部：中断恢复续跑（热发布 M2/M3，spec 2026-10-16-hot-deploy-design）。
   * 复用原 task 行（D3 拍板）：interrupted/awaiting_approval --resume--> running，
   * 轮输入用 text 合成指令（经 firstTurnPrompt 注入），task.prompt 保持原文不污染。
   */
  resumeTaskId: z.string().optional(),
  /** 无人值守触发（定时/钩子/工作流）：缺省权限模式强制按变更前问询执行；
   *  工作流派发携带配置值（2026-10-14 拍板：以工作流配置为准，缺省完全权限），覆盖此缺省 */
  unattended: z.boolean().optional(),
  /** 消息级权限模式覆盖（工作流派发注入；仅无人值守管线使用） */
  permissionMode: AgentPermissionModeSchema.optional(),
  /** L2 autoDev 轮标记（工作流派发注入）：orchestrator 据此装配 git-write 放行白名单 */
  autoDev: z.boolean().optional(),
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
  /** 归属任务 id（一轮用户消息 = 一个 task，前端回合合并/工具装饰用）；旧数据为空 */
  taskId?: string;
  createdAt: string;
}

// === 审批 ===
export interface ApprovalCard {
  gateId: string;
  title: string;
  summary: string;
  /** 一键成策略草稿（specs/2026-10-12 §8.1 M2）：host_exec 审批卡展示「通过并记住」
   *  入口（前缀可编辑）；仅 admin 属主的轮携带。undefined=不展示 */
  adoptDraft?: { hostCode: string; prefix: string; agentId?: string };
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
  /** 审批人勾选「通过并记住」时携带（编辑后的前缀；orchestrator 据此落策略） */
  adoptPrefix?: string;
}

/** AskUserQuestion 单个问题（与 CLI 工具输入 schema 对齐；数据形状，resolver 类型在 ports 定义） */
export interface QuestionItem {
  /** 问题原文（同时是 answers 的 key，须与 input.questions[].question 逐字一致） */
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** 用户对一轮 AskUserQuestion 的作答结果 */
export interface QuestionResolution {
  /** key = QuestionItem.question 原文；单选=选项 label，多选=多个 label 逗号串 */
  answers: Record<string, string>;
  /** 自由文本补充（选「其他」时可以是填写内容，也可以为空） */
  response?: string;
  /** 超时/无渠道降级标记（观测用；空答案时模型按「未回答」分支继续） */
  timedOut?: boolean;
}

/** runner 命中 AskUserQuestion 时抛给编排层的问题请求 */
export interface QuestionRequest {
  taskId: string;
  toolUseId: string;
  questions: QuestionItem[];
}
