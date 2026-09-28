/**
 * 反馈模块领域模型（spec docs/superpowers/specs/2026-09-20-feedback-module-design.md）。
 * 纯 CRUD：用户提交改进意见（类别+文本+截图），管理员回复并推进状态。
 */

export const FEEDBACK_CATEGORIES = ["ui", "ue", "feature", "logic", "other"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/** open=待处理 accepted=处理中(管理员已接手跟进) resolved=已完成 closed=已关闭（存储值不变，仅展示词） */
export const FEEDBACK_STATUSES = ["open", "accepted", "resolved", "closed"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** 类别中文标签（反馈引用注入文本与前端候选描述共用，两端语义一致） */
export const FEEDBACK_CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  ui: "界面",
  ue: "体验",
  feature: "功能",
  logic: "逻辑",
  other: "其他",
};

/** 状态中文标签（同上共用） */
export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  open: "待处理",
  accepted: "处理中",
  resolved: "已完成",
  closed: "已关闭",
};

export interface Feedback {
  id: string;
  /** 提交人（服务端取当前登录者，不信任客户端） */
  userId: string;
  category: FeedbackCategory;
  content: string;
  /** 附件文件名数组（仅文件名，不含路径；实际文件在该反馈的附件目录下） */
  images: string[];
  /** 关联对话记录（本人会话 id；spec 2026-09-28-feedback-conversation-attachment-design）。
   * 指针语义：引用注入时现读转录，不落快照。M1 服务端按 ≤1 条收口，数组为多条预留。 */
  conversationIds: string[];
  /** 关联应用（应用管家制 spec §7；弱引用）：应用页反馈入口带入；平台级反馈缺省 */
  appId?: string;
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackReply {
  id: string;
  feedbackId: string;
  userId: string;
  /** 服务端按提交者 viewer.role 落库，不信任客户端入参 */
  authorRole: "admin" | "user";
  content: string;
  createdAt: string;
}

export function isFeedbackCategory(v: unknown): v is FeedbackCategory {
  return typeof v === "string" && (FEEDBACK_CATEGORIES as readonly string[]).includes(v);
}

export function isFeedbackStatus(v: unknown): v is FeedbackStatus {
  return typeof v === "string" && (FEEDBACK_STATUSES as readonly string[]).includes(v);
}
