import type { Feedback, FeedbackReply, FeedbackStatus } from "../domain/feedback.js";

/**
 * 反馈存储（spec 2026-09-20-feedback-module-design §3）。
 * 属主/管理员分流在 web-channel handler 内按 viewer.role 执行（同审计面范式），
 * store 不做 visible 语义——反馈无共享授予，owner 即 userId 本身。
 */
export interface FeedbackStore {
  create(feedback: Feedback): Promise<void>;
  get(id: string): Promise<Feedback | undefined>;
  listByUser(userId: string): Promise<Feedback[]>;
  listAll(): Promise<Feedback[]>;
  /** 状态流转（仅 admin 端点调用）；实现内更新 updatedAt */
  updateStatus(id: string, status: FeedbackStatus): Promise<void>;
  addReply(reply: FeedbackReply): Promise<void>;
  listReplies(feedbackId: string): Promise<FeedbackReply[]>;
}
