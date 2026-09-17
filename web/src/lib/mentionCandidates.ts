import { apiFetch } from "./auth";

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

export interface MentionCandidates {
  skills: MentionCandidateItem[];
  connectors: MentionCandidateItem[];
  files: MentionFileCandidate[];
}

export const EMPTY_MENTION_CANDIDATES: MentionCandidates = {
  skills: [],
  connectors: [],
  files: [],
};

/** 拉取该 agent 下的 @/​/$ 引用候选（技能/连接器全量，文件限 50 条） */
export async function fetchMentionCandidates(agentId: string): Promise<MentionCandidates> {
  const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/mention-candidates`);
  if (!res.ok) throw new Error(`加载引用候选失败: ${res.status}`);
  return (await res.json()) as MentionCandidates;
}
