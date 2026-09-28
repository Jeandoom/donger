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
  /** 关联应用（应用管家制 spec §7；弱引用原样携带） */
  appId?: string | null;
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

// ===== 应用生命周期事件（应用管家制 spec §6.1；发射方=app-tools）=====

export interface AppPublishedFact {
  appId: string;
  name: string;
  /** 本次发布版本号 */
  version: number;
  /** 发布前的当前版本；null=首次发布 */
  previousVersion: number | null;
  /** 发布来源：agent 会话工具 or 属主 UI 手动切版 */
  publishedBy: { kind: "agent" | "user"; agentId?: string };
  /** 责任管家（弱引用原样携带，NULL=内置应用管家兜底） */
  managerAgentId: string | null;
  at: string;
}

export function buildAppPublishedPayload(fact: AppPublishedFact): string {
  return JSON.stringify({ event: "app.published", app: fact });
}

export interface AppRolledBackFact {
  appId: string;
  name: string;
  from: number;
  to: number;
  rolledBy: { kind: "agent" | "user"; agentId?: string };
  managerAgentId: string | null;
  at: string;
}

export function buildAppRolledBackPayload(fact: AppRolledBackFact): string {
  return JSON.stringify({ event: "app.rolled_back", app: fact });
}

/** testTrigger 用固定样例 */
export function sampleAppPublishedPayload(): string {
  return buildAppPublishedPayload({
    appId: "app_sample",
    name: "样例应用",
    version: 1,
    previousVersion: null,
    publishedBy: { kind: "agent", agentId: "sample-agent" },
    managerAgentId: null,
    at: "1970-01-01T00:00:00.000Z",
  });
}
