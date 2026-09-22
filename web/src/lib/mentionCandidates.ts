import { apiFetch } from "./auth";
import type { FeedbackStatus } from "./feedback";

export interface MentionCandidateItem {
  id: string;
  name: string;
  description?: string;
}

export interface MentionFileCandidate {
  /** 文件引用的 scope（当前仅 runtime = agents/<agentId>/workspace，与文件浏览器同口径） */
  scope: "runtime";
  path: string;
  label: string;
}

export interface MentionConversationCandidate {
  id: string;
  title: string;
  updatedAt: string;
}

export interface MentionFeedbackCandidate {
  id: string;
  /** 消毒后的标记文本（正文派生，与后端 feedbackMarkerLabel 同算法） */
  label: string;
  category: string;
  status: FeedbackStatus;
  updatedAt: string;
  /** 正文前 ~60 字（描述行展示，不做标记） */
  preview: string;
}

export interface MentionCandidates {
  skills: MentionCandidateItem[];
  connectors: MentionCandidateItem[];
  files: MentionFileCandidate[];
  /** 该智能体是否开启了会话引用（关闭 = conversations 恒空，浮层提示功能未开启） */
  conversationRefEnabled: boolean;
  conversations: MentionConversationCandidate[];
  /** 该智能体是否开启了反馈引用（关闭 = feedbacks 恒空，浮层提示功能未开启） */
  feedbackRefEnabled: boolean;
  feedbacks: MentionFeedbackCandidate[];
}

export const EMPTY_MENTION_CANDIDATES: MentionCandidates = {
  skills: [],
  connectors: [],
  files: [],
  conversationRefEnabled: false,
  conversations: [],
  feedbackRefEnabled: false,
  feedbacks: [],
};

/** 拉取该 agent 下的 @/​/$/%/# 引用候选（技能/连接器/会话/反馈全量，文件/会话/反馈各限 50 条） */
export async function fetchMentionCandidates(
  agentId: string,
  currentConversationId?: string,
): Promise<MentionCandidates> {
  const q = currentConversationId
    ? `?conversationId=${encodeURIComponent(currentConversationId)}`
    : "";
  const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/mention-candidates${q}`);
  if (!res.ok) throw new Error(`加载引用候选失败: ${res.status}`);
  return (await res.json()) as MentionCandidates;
}
