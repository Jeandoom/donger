import type { ConversationSummary } from "../types";

/**
 * 对话模块侧栏的纯逻辑（分组/星标/排序/默认 agent 解析）。
 * 持久化：starredAgentIds/agentOrder 存 users 表（PATCH /api/users/me/sidebar-prefs），
 * 折叠态存 localStorage；本文件不做 IO。
 */

/** 侧栏偏好：星标置顶区（有序，[0] 即默认对话agent）+ 普通分组区排序 */
export interface SidebarPrefs {
  starredAgentIds: string[];
  agentOrder: string[];
}

export function emptyPrefs(): SidebarPrefs {
  return { starredAgentIds: [], agentOrder: [] };
}

/**
 * 规范化偏好：剔除已删除/重复的智能体，新增智能体追加普通区尾部。
 * managedIds = 参与偏好管理的智能体全集（不含内置 assist 等固定分组）。
 */
export function normalizeSidebarPrefs(
  managedIds: readonly string[],
  prefs: SidebarPrefs,
): SidebarPrefs {
  const known = new Set(managedIds);
  const starredAgentIds: string[] = [];
  for (const id of prefs.starredAgentIds) {
    if (known.has(id) && !starredAgentIds.includes(id)) starredAgentIds.push(id);
  }
  const inStarred = new Set(starredAgentIds);
  const agentOrder: string[] = [];
  for (const id of prefs.agentOrder) {
    if (known.has(id) && !inStarred.has(id) && !agentOrder.includes(id)) agentOrder.push(id);
  }
  for (const id of managedIds) {
    if (!inStarred.has(id) && !agentOrder.includes(id)) agentOrder.push(id);
  }
  return { starredAgentIds, agentOrder };
}

/** 星标切换：加星 → 追加固定区尾部；去星 → 移回普通区尾部（不动另一区内部排序） */
export function toggleStarred(prefs: SidebarPrefs, agentId: string): SidebarPrefs {
  if (prefs.starredAgentIds.includes(agentId)) {
    return {
      starredAgentIds: prefs.starredAgentIds.filter((id) => id !== agentId),
      agentOrder: [...prefs.agentOrder, agentId],
    };
  }
  return {
    starredAgentIds: [...prefs.starredAgentIds, agentId],
    agentOrder: prefs.agentOrder.filter((id) => id !== agentId),
  };
}

/** 区内拖拽重排（arrayMove；越界索引夹取） */
export function reorderIds(list: readonly string[], from: number, to: number): string[] {
  const next = [...list];
  const clampedFrom = Math.max(0, Math.min(from, next.length - 1));
  const clampedTo = Math.max(0, Math.min(to, next.length - 1));
  const [moved] = next.splice(clampedFrom, 1);
  if (moved === undefined) return next;
  next.splice(clampedTo, 0, moved);
  return next;
}

// 「默认对话agent」概念已移除：新建会话一律经分组头「+」显式指定 agent；
// 星标仅保留置顶收藏语义，不再决定默认目标。

/**
 * 会话按 agentId 分组（列表接口按 updatedAt DESC 返回，组内保序）。
 * 空 agentId = 旧版默认会话（task-flow 已退役），不展示；
 * agentId 非空但不在已知集合 = 孤儿会话（如 builder 补建会话），归系统分组兜底。
 */
export function groupConversations(
  conversations: readonly ConversationSummary[],
  knownAgentIds: ReadonlySet<string>,
): { byAgent: Map<string, ConversationSummary[]>; orphans: ConversationSummary[] } {
  const byAgent = new Map<string, ConversationSummary[]>();
  const orphans: ConversationSummary[] = [];
  for (const conversation of conversations) {
    if (!conversation.agentId) continue;
    const list = byAgent.get(conversation.agentId) ?? [];
    list.push(conversation);
    byAgent.set(conversation.agentId, list);
    if (!knownAgentIds.has(conversation.agentId)) orphans.push(conversation);
  }
  return { byAgent, orphans };
}

/** 相对时间标签（截图样式）：刚刚 / 19h / 3d / 2mo / 1y */
export function formatRelativeTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}
