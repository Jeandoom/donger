import type { ConversationSummary } from "../types";

/**
 * 对话侧栏纯逻辑（chat UE 优化轮：扁平时间流 + 视图切换 + agent 筛选 + 标题检索）。
 * 持久化：starredAgentIds（星标 agent = 快速筛选 chips 数据源）存 users 表；
 * 分组折叠态存 localStorage；本文件不做 IO。
 * 旧 agent 分组/拖拽排序随扁平化退役（specs/2026-11-05-chat-ue-optimization-design.md D1）。
 */

/** 侧栏偏好：星标智能体（[0] 最先收藏）；agentOrder 保留字段兼容旧持久化数据，扁平视图不消费 */
export interface SidebarPrefs {
  starredAgentIds: string[];
  agentOrder: string[];
}

export function emptyPrefs(): SidebarPrefs {
  return { starredAgentIds: [], agentOrder: [] };
}

/**
 * 规范化偏好：剔除已删除/重复的智能体，新增智能体追加尾部。
 * managedIds = 参与偏好管理的智能体全集。
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

/** 星标切换（星标智能体 = 侧栏「星标」视图 + chips 快速筛选的数据源；去星移回 agentOrder 尾部） */
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

/** 侧栏视图：全部 / 星标智能体的会话 / 归档 */
export type SidebarView = "all" | "starred" | "archived";

export interface ConversationFilter {
  view: SidebarView;
  /** 星标视图的判定数据源 */
  starredAgentIds: readonly string[];
  /** agent 筛选（空 = 不筛） */
  agentId?: string;
  /** 标题/智能体名子串（大小写不敏感；空 = 不筛） */
  keyword?: string;
}

/** 按视图 + agent + 关键词过滤（输入保持 updatedAt 倒序，不做重排） */
export function filterConversations(
  conversations: readonly ConversationSummary[],
  filter: ConversationFilter,
  isStarredAgent: (agentId: string) => boolean,
): ConversationSummary[] {
  let list = [...conversations];
  if (filter.view === "archived") {
    list = list.filter((c) => c.archived);
  } else {
    list = list.filter((c) => !c.archived && !c.isDraft);
    if (filter.view === "starred") {
      list = list.filter((c) => c.agentId && isStarredAgent(c.agentId));
    }
  }
  if (filter.agentId) {
    list = list.filter((c) => c.agentId === filter.agentId);
  }
  const kw = (filter.keyword ?? "").trim().toLowerCase();
  if (kw) {
    list = list.filter(
      (c) =>
        (c.title || "(无标题)").toLowerCase().includes(kw) ||
        c.lastMessagePreview?.toLowerCase().includes(kw),
    );
  }
  return list;
}

export type TimeGroupKey = "today" | "yesterday" | "week" | "month" | "older";

export interface TimeGroup {
  key: TimeGroupKey;
  label: string;
  items: ConversationSummary[];
}

const GROUP_LABELS: Record<TimeGroupKey, string> = {
  today: "今天",
  yesterday: "昨天",
  week: "近 7 天",
  month: "近 30 天",
  older: "更早",
};

const GROUP_ORDER: TimeGroupKey[] = ["today", "yesterday", "week", "month", "older"];

/** 输入按 updatedAt 倒序 → 按本地日历切时间组（组内保序；空组不返回） */
export function groupConversationsByTime(
  conversations: readonly ConversationSummary[],
  now: Date = new Date(),
): TimeGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const buckets = new Map<TimeGroupKey, ConversationSummary[]>();
  for (const conversation of conversations) {
    const t = Date.parse(conversation.updatedAt);
    let key: TimeGroupKey;
    if (Number.isNaN(t)) {
      key = "older";
    } else if (t >= startOfToday) {
      key = "today";
    } else if (t >= startOfToday - dayMs) {
      key = "yesterday";
    } else if (t >= startOfToday - 7 * dayMs) {
      key = "week";
    } else if (t >= startOfToday - 30 * dayMs) {
      key = "month";
    } else {
      key = "older";
    }
    const list = buckets.get(key) ?? [];
    list.push(conversation);
    buckets.set(key, list);
  }
  return GROUP_ORDER.filter((key) => (buckets.get(key)?.length ?? 0) > 0).map((key) => ({
    key,
    label: GROUP_LABELS[key],
    items: buckets.get(key) ?? [],
  }));
}

/** 相对时间标签：刚刚 / 19h / 3d / 2mo / 1y */
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
