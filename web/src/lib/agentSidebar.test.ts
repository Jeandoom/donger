import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "../types";
import {
  filterConversations,
  formatRelativeTime,
  groupConversationsByTime,
  normalizeSidebarPrefs,
  toggleStarred,
} from "./agentSidebar";

function conv(
  id: string,
  agentId: string,
  updatedAt = "2026-09-18T10:00:00Z",
  extra: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    userId: "u",
    sdkSessionId: "",
    title: id,
    channelId: "web",
    agentId,
    createdAt: updatedAt,
    updatedAt,
    archived: false,
    ...extra,
  };
}

describe("normalizeSidebarPrefs", () => {
  it("剔除已删除智能体并保持顺序", () => {
    const prefs = normalizeSidebarPrefs(["a", "b", "c"], {
      starredAgentIds: ["x", "c", "c"],
      agentOrder: ["b", "x", "gone"],
    });
    expect(prefs).toEqual({ starredAgentIds: ["c"], agentOrder: ["b", "a"] });
  });

  it("新增智能体追加尾部", () => {
    const prefs = normalizeSidebarPrefs(["a", "b", "new"], {
      starredAgentIds: ["a"],
      agentOrder: ["b"],
    });
    expect(prefs).toEqual({ starredAgentIds: ["a"], agentOrder: ["b", "new"] });
  });
});

describe("toggleStarred", () => {
  it("加星/去星互斥切换", () => {
    const added = toggleStarred({ starredAgentIds: ["a"], agentOrder: [] }, "b");
    expect(added.starredAgentIds).toEqual(["a", "b"]);
    const removed = toggleStarred(added, "a");
    expect(removed.starredAgentIds).toEqual(["b"]);
  });
});

describe("filterConversations", () => {
  const list = [
    conv("1", "a", "2026-09-18T10:00:00Z"),
    conv("2", "b", "2026-09-17T10:00:00Z"),
    conv("3", "", "2026-09-16T10:00:00Z"),
    conv("4", "a", "2026-09-15T10:00:00Z", { archived: true }),
    conv("draft-1", "a", "2026-09-14T10:00:00Z", { isDraft: true }),
    conv("5", "b", "2026-09-13T10:00:00Z", {
      title: "报表汇总",
      lastMessagePreview: "含摘要片段的回复",
    }),
  ];
  const isStarred = (agentId: string) => agentId === "a";

  it("all 视图：排除归档与草稿（旧默认会话 agentId 空保留）", () => {
    const out = filterConversations(list, { view: "all", starredAgentIds: [] }, isStarred);
    expect(out.map((c) => c.id)).toEqual(["1", "2", "3", "5"]);
  });

  it("starred 视图：仅星标智能体的会话", () => {
    const out = filterConversations(list, { view: "starred", starredAgentIds: [] }, isStarred);
    expect(out.map((c) => c.id)).toEqual(["1"]);
  });

  it("archived 视图：仅归档会话", () => {
    const out = filterConversations(list, { view: "archived", starredAgentIds: [] }, isStarred);
    expect(out.map((c) => c.id)).toEqual(["4"]);
  });

  it("agent 筛选叠加视图", () => {
    const out = filterConversations(
      list,
      { view: "all", starredAgentIds: [], agentId: "b" },
      isStarred,
    );
    expect(out.map((c) => c.id)).toEqual(["2", "5"]);
  });

  it("关键词匹配标题（大小写不敏感）与最后消息摘要", () => {
    const byTitle = filterConversations(
      list,
      { view: "all", starredAgentIds: [], keyword: "报表" },
      isStarred,
    );
    expect(byTitle.map((c) => c.id)).toEqual(["5"]);
    const byPreview = filterConversations(
      list,
      { view: "all", starredAgentIds: [], keyword: "摘要片段" },
      isStarred,
    );
    expect(byPreview.map((c) => c.id)).toEqual(["5"]);
  });
});

describe("groupConversationsByTime", () => {
  const now = new Date("2026-09-18T15:00:00+08:00");
  const iso = (dayOffset: number) =>
    new Date(now.getTime() - dayOffset * 86_400_000).toISOString();

  it("按本地日历切组：今天/昨天/近7天/近30天/更早，空组不返回", () => {
    const groups = groupConversationsByTime(
      [
        conv("today", "a", iso(0)),
        conv("yesterday", "a", iso(1)),
        conv("week", "a", iso(5)),
        conv("month", "a", iso(20)),
        conv("older", "a", iso(45)),
      ],
      now,
    );
    expect(groups.map((g) => g.key)).toEqual([
      "today",
      "yesterday",
      "week",
      "month",
      "older",
    ]);
    expect(groups[0]?.items.map((c) => c.id)).toEqual(["today"]);
  });

  it("输入保持倒序语义（组内保序）", () => {
    const groups = groupConversationsByTime(
      [conv("newer", "a", iso(0.1)), conv("older-same-day", "a", iso(0.2))],
      now,
    );
    expect(groups.length).toBe(1);
    expect(groups[0]?.items.map((c) => c.id)).toEqual(["newer", "older-same-day"]);
  });

  it("非法时间落「更早」组不炸", () => {
    const groups = groupConversationsByTime([conv("bad", "a", "not-a-date")], now);
    expect(groups.map((g) => g.key)).toEqual(["older"]);
  });
});

describe("formatRelativeTime", () => {
  it("分级标签", () => {
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    expect(formatRelativeTime(iso(10_000))).toBe("刚刚");
    expect(formatRelativeTime(iso(5 * 60_000))).toBe("5m");
    expect(formatRelativeTime(iso(19 * 3_600_000))).toBe("19h");
    expect(formatRelativeTime(iso(3 * 86_400_000))).toBe("3d");
    expect(formatRelativeTime(iso(45 * 86_400_000))).toBe("1mo");
    expect(formatRelativeTime("not-a-date")).toBe("");
  });
});
