import type { ApprovalCard, IncomingMessage, OutgoingMessage } from "../domain/types.js";

/** 渠道返回的审批结果（独立于 ApprovalDecision，便于渠道附带响应者等额外信息） */
export interface ApprovalResult {
  approved: boolean;
  reason?: string;
  /** 实际点击审批的用户标识（多用户场景用，M10） */
  responderId?: string;
}

/** IM / 控制台入口端口 */
export interface Channel {
  readonly id: string;
  /** 流式模式：跳过 ack 确认 + 跳过结果汇总（agent 文本直接展示） */
  readonly streaming?: boolean;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  send(threadId: string, msg: OutgoingMessage): Promise<void>;
  requestApproval(threadId: string, card: ApprovalCard): Promise<ApprovalResult>;
  /** 收到确认（可选）；返回 ack 上下文供 ackEnd 用 */
  ack?(threadId: string): Promise<unknown>;
  /** 撤销确认（可选，任务完成后调用） */
  ackEnd?(ackCtx: unknown): Promise<void>;
}
