// 反馈模块数据获取 + 词表映射（UI 在 FeedbackPage）。
// 后端契约见 docs/superpowers/specs/2026-09-20-feedback-module-design.md §4。

import { apiFetch, getToken } from "./auth";

export const FEEDBACK_CATEGORIES = ["ui", "ue", "feature", "logic", "other"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_STATUSES = ["open", "accepted", "resolved", "closed"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  ui: "界面 UI",
  ue: "体验 UE",
  feature: "功能",
  logic: "逻辑",
  other: "其他",
};

export const STATUS_LABELS: Record<FeedbackStatus, string> = {
  open: "待处理",
  accepted: "处理中",
  resolved: "已完成",
  closed: "已关闭",
};

export const STATUS_TONES: Record<FeedbackStatus, "info" | "primary" | "success" | "neutral"> = {
  open: "info",
  accepted: "primary",
  resolved: "success",
  closed: "neutral",
};

export interface FeedbackItem {
  id: string;
  userId: string;
  userName?: string;
  category: FeedbackCategory;
  content: string;
  images: string[];
  /** 关联对话记录（指针元数据；agent # 引用该反馈时按需注入转录） */
  conversations?: FeedbackConversationRef[];
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackConversationRef {
  id: string;
  title?: string;
  updatedAt?: string;
  /** 关联会话已被删除（详情页置灰占位） */
  missing?: boolean;
}

/** 反馈素材选择器候选项（本人会话，updatedAt 降序，服务端分页） */
export interface ConversationCandidate {
  id: string;
  title: string;
  updatedAt: string;
}

export interface FeedbackReplyDTO {
  id: string;
  feedbackId: string;
  userId: string;
  /** 回复人姓名（服务端按 userId 补齐；取不到时回退 userId） */
  authorName?: string;
  authorRole: "admin" | "user";
  content: string;
  createdAt: string;
}

export async function fetchFeedbackList(): Promise<FeedbackItem[]> {
  const r = await apiFetch("/api/feedback");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as { items: FeedbackItem[] };
  return data.items;
}

export async function createFeedback(input: {
  category?: FeedbackCategory;
  content: string;
  images: string[];
  /** 关联对话记录 id（≤1 条，须为本人会话） */
  conversationIds?: string[];
  key?: string;
}): Promise<FeedbackItem> {
  const r = await apiFetch("/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as FeedbackItem;
}

/** 反馈素材选择器数据源：本人会话分页（默认最近 10 条） */
export async function fetchConversationCandidates(opts: {
  limit?: number;
  offset?: number;
  q?: string;
}): Promise<{ items: ConversationCandidate[]; total: number }> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  if (opts.q) params.set("q", opts.q);
  const qs = params.toString();
  const r = await apiFetch(`/api/feedback/conversation-candidates${qs ? `?${qs}` : ""}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as { items: ConversationCandidate[]; total: number };
}

export async function fetchFeedbackDetail(id: string): Promise<FeedbackItem> {
  const r = await apiFetch(`/api/feedback/${id}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as FeedbackItem;
}

export async function fetchFeedbackReplies(id: string): Promise<FeedbackReplyDTO[]> {
  const r = await apiFetch(`/api/feedback/${id}/replies`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as { replies: FeedbackReplyDTO[] };
  return data.replies;
}

export async function addFeedbackReply(id: string, content: string): Promise<FeedbackReplyDTO> {
  const r = await apiFetch(`/api/feedback/${id}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) {
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as FeedbackReplyDTO;
}

export async function updateFeedbackStatus(id: string, status: FeedbackStatus): Promise<void> {
  const r = await apiFetch(`/api/feedback/${id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

/** 上传反馈截图（单张 ≤2MB 图片）；返回服务端落盘安全名 */
export async function uploadFeedbackImage(draftKey: string, file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const r = await apiFetch(`/api/feedback/attachments?key=${encodeURIComponent(draftKey)}`, {
    method: "POST",
    body: form,
  });
  if (!r.ok) {
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `HTTP ${r.status}`);
  }
  const data = (await r.json()) as { name: string };
  return data.name;
}

/** 反馈附件回读 URL（img src 用；?token= 鉴权同 /uploads） */
export function feedbackImageUrl(feedbackId: string, name: string): string {
  const token = getToken();
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  return `/api/feedback/${encodeURIComponent(feedbackId)}/attachments/${encodeURIComponent(name)}${qs}`;
}

export function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const min = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (diff < min) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(t).toLocaleDateString();
}
