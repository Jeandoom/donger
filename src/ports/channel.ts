import type {
  ApprovalCard,
  IncomingMessage,
  OutgoingMessage,
  QuestionItem,
  QuestionResolution,
} from "../domain/types.js";

/** 渠道返回的审批结果（独立于 ApprovalDecision，便于渠道附带响应者等额外信息） */
export interface ApprovalResult {
  approved: boolean;
  reason?: string;
  /** 实际点击审批的用户标识（多用户场景用，M10） */
  responderId?: string;
  /** 审批附带的评论（T17.3：验收门评论随决议落 task_comments） */
  comment?: string;
}

/** 凭证缺失问询单项：agent 勾选但当前用户未配置的模板（结构元数据，不含值） */
export interface MissingCredentialItem {
  code: string;
  name: string;
  description?: string;
  /** 模板声明的键名清单（用户需填写的 value 对应的 k） */
  keys: string[];
}

/** 凭证缺失问询请求 */
export interface MissingCredentialsRequest {
  taskId: string;
  conversationId: string;
  items: MissingCredentialItem[];
}

/** 问询决议：继续执行（带病跑）/ 暂停（挂起任务，稍后处理）/ 重试（用户已配置后重跑预检）/ 取消任务 */
export type MissingCredentialsDecision = "continue" | "pause" | "retry" | "cancel";

/** IM / 控制台入口端口 */
export interface Channel {
  readonly id: string;
  /** 流式模式：跳过 ack 确认 + 跳过结果汇总（agent 文本直接展示） */
  readonly streaming?: boolean;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  /** 注册会话停止处理器（WebChannel 使用）。 */
  onCancel?(handler: (conversationId: string) => boolean | Promise<boolean>): void;
  send(threadId: string, msg: OutgoingMessage): Promise<void>;
  /** 推送文本消息（SSE 版本，WebChannel 实现） */
  pushText?(conversationId: string, text: string): void;
  /** 推送单条助手消息的文本增量（SSE 版本，WebChannel 实现） */
  pushTextDelta?(conversationId: string, messageId: string, text: string): void;
  /** 推送单条助手消息的思考增量（SSE 版本，WebChannel 实现；不持久化为聊天消息） */
  pushThinkingDelta?(conversationId: string, messageId: string, text: string): void;
  /** 推送中间过程行（工具调用/失败等，SSE 版本，WebChannel 实现） */
  pushActivity?(conversationId: string, text: string): void;
  /** 推送结构化工具调用事件（SSE 版本，WebChannel 实现；输入为截断摘要，完整内容落审计） */
  pushToolUse?(
    conversationId: string,
    event: { toolUseId: string; tool: string; inputPreview: string },
  ): void;
  /** 推送结构化工具结果事件（SSE 版本，WebChannel 实现；输出为截断摘要） */
  pushToolResult?(
    conversationId: string,
    event: { toolUseId: string; outputPreview: string; isError: boolean },
  ): void;
  /** 推送完成通知（SSE 版本） */
  pushResult?(conversationId: string, subtype: "success" | "error", text: string): void;
  /** 推送审批卡片（SSE 版本） */
  pushApprovalCard?(
    conversationId: string,
    gateId: string,
    title: string,
    summary: string,
  ): Promise<void>;
  requestApproval(threadId: string, card: ApprovalCard): Promise<ApprovalResult>;
  /**
   * 停止任务时解开该会话全部挂起审批（Web 实现）：审批不设超时后，这是 abort 路径
   * 解开 canUseTool await 的唯一通道——否则挂审批时点停止，轮次收口会永久卡住。
   */
  cancelPendingApprovals?(conversationId: string): void;
  /**
   * AskUserQuestion 问询（Web 实现；未实现的渠道由编排层按「空答案」降级，
   * 模型收到 "The user did not answer the questions." 后自走默认假设分支）。
   * threadId 即 conversationId（Web SSE 语义），卡片广播与 pending 归属都用它。
   */
  requestUserInput?(
    threadId: string,
    req: {
      taskId: string;
      conversationId: string;
      toolUseId: string;
      questions: QuestionItem[];
    },
  ): Promise<QuestionResolution>;
  /** 凭证缺失问询（Web/CLI 实现；未实现的渠道由编排层按「暂停」降级并提示到 Web 操作）。 */
  requestMissingCredentials?(
    threadId: string,
    req: MissingCredentialsRequest,
  ): Promise<MissingCredentialsDecision>;
  /** 收到确认（可选）；返回 ack 上下文供 ackEnd 用 */
  ack?(threadId: string): Promise<unknown>;
  /** 撤销确认（可选，任务完成后调用） */
  ackEnd?(ackCtx: unknown): Promise<void>;
}
