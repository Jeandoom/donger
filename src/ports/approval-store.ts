/**
 * 审批决议落库端口（热发布 M3，spec docs/superpowers/specs/2026-10-16-hot-deploy-design.md §6）。
 *
 * 设计核心：**请求即落库**——审批卡创建时写 pending 行（进程随时可死），决议走
 * 「UPDATE ... WHERE status='pending'」单条事务（changes=0 即他端已决议 → 409 幂等）。
 * 重启后 getPendingApproval 从 DB 重臂卡片，决议经 orchestrator.resumeAfterApproval 续跑。
 */
export type ApprovalRowStatus = "pending" | "approved" | "rejected" | "expired" | "canceled";

export interface ApprovalRequestRow {
  /** = 前端 approvalId（respond 目标）；生成点在 approval-flow，DB 行与卡片同键 */
  id: string;
  taskId: string;
  conversationId: string;
  gateId: string;
  tool?: string;
  title: string;
  summary?: string;
  /** JSON：{input, toolUseId, adoptDraft?}——跨重启续跑/一键成策略的原材料 */
  payload?: string;
  /** 受理渠道（web/dingtalk/…） */
  channel: string;
  status: ApprovalRowStatus;
  /** JSON：{approved, reason, comment, responderId, adoptPrefix} */
  decision?: string;
  createdAt: string;
  decidedAt?: string;
}

/** 决议内容（落 decision JSON 列的形态） */
export interface ApprovalDecisionRecord {
  approved: boolean;
  reason?: string;
  comment?: string;
  responderId?: string;
  adoptPrefix?: string;
}

export interface ApprovalStore {
  create(row: ApprovalRequestRow): Promise<void>;
  get(id: string): Promise<ApprovalRequestRow | undefined>;
  /**
   * 幂等决议：仅 pending → decided；返回 false = 行已被决议（他端先到/双击），调用方 409。
   */
  decide(
    id: string,
    status: "approved" | "rejected",
    decision: ApprovalDecisionRecord,
    decidedAt: string,
  ): Promise<boolean>;
  /** 会话当前 pending 行（重臂查询用；通常 0/1 条） */
  listPendingByConversation(conversationId: string): Promise<ApprovalRequestRow[]>;
  /** 会话挂起审批整体收口（cancelPendingApprovals/停止任务联动；仅 pending 行受影响） */
  cancelByConversation(conversationId: string): Promise<void>;
}
