/**
 * 事件触发器 payload 契约（spec 2026-09-28-event-trigger-feedback-design §4）。
 * payload 是 sourceOutput——与 hook body 同语义：matcher 的判定对象、经 wrapUntrusted
 * 注入 prompt 模板的不可信内容。契约归发射方；此处只收口「构造」保证两端形状一致。
 */
import { FEEDBACK_CATEGORY_LABELS, type FeedbackCategory } from "./feedback.js";

export interface FeedbackCreatedFact {
  id: string;
  category: FeedbackCategory;
  status: string;
  content: string;
  submitterId: string;
  /** userStore 解析，查不到降级 submitterId（由发射方负责） */
  submitterName: string;
  imageCount: number;
  createdAt: string;
}

export function buildFeedbackCreatedPayload(fact: FeedbackCreatedFact): string {
  return JSON.stringify({
    event: "feedback.created",
    feedback: { ...fact, categoryLabel: FEEDBACK_CATEGORY_LABELS[fact.category] },
  });
}

/** testTrigger 用固定样例（不取真实反馈；时间戳固定保证测试确定性） */
export function sampleFeedbackCreatedPayload(): string {
  return buildFeedbackCreatedPayload({
    id: "00000000-0000-4000-8000-000000000000",
    category: "feature",
    status: "open",
    content: "（样例反馈）希望导出功能支持自定义字段",
    submitterId: "sample-user",
    submitterName: "样例用户",
    imageCount: 0,
    createdAt: "1970-01-01T00:00:00.000Z",
  });
}
