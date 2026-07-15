import type { ApprovalCard, IncomingMessage, OutgoingMessage } from "../domain/types.js";

/** 渠道返回的审批结果（独立于 ApprovalDecision，便于渠道附带响应者等额外信息） */
export interface ApprovalResult {
  approved: boolean;
  reason?: string;
  /** 实际点击审批的用户标识（多用户场景用，M10） */
  responderId?: string;
}

/** 凭证门单项：要求用户提供的一个凭证 */
export interface CredentialRequestItem {
  key: string;
  label: string;
  description?: string;
  secret: boolean;
  packName: string;
}

/** 凭证门请求：任务执行前缺失的必需凭证 */
export interface CredentialRequest {
  taskId: string;
  conversationId: string;
  items: CredentialRequestItem[];
}

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
  /** 推送完成通知（SSE 版本） */
  pushResult?(conversationId: string, subtype: "success" | "error", text: string): void;
  /** 推送审批卡片（SSE 版本） */
  pushApprovalCard?(conversationId: string, gateId: string, title: string, summary: string): Promise<void>;
  requestApproval(threadId: string, card: ApprovalCard): Promise<ApprovalResult>;
  /** 收集缺失凭证（WebChannel 实现；钉钉不实现 → 凭证门降级为失败提示）。 */
  requestCredentials?(threadId: string, req: CredentialRequest): Promise<Record<string, string>>;
  /** 收到确认（可选）；返回 ack 上下文供 ackEnd 用 */
  ack?(threadId: string): Promise<unknown>;
  /** 撤销确认（可选，任务完成后调用） */
  ackEnd?(ackCtx: unknown): Promise<void>;
}
