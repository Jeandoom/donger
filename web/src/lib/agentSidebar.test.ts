import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "../types";
import {
  formatRelativeTime,
  groupConversations,
  normalizeSidebarPrefs,
  reorderIds,
  toggleStarred,
} from "./agentSidebar";

function conv(
  id: string,
  agentId: string,
  updatedAt = "2026-09-18T10:00:00Z",
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
  };
}

describe("normalizeSidebarPrefs", () => {
  it("剔除已删除智能体并保持各区内部顺序", () => {
    const prefs = normalizeSidebarPrefs(["a", "b", "c"], {
      starredAgentIds: ["x", "c", "c"],
      agentOrder: ["b", "x", "gone"],
    });
    expect(prefs).toEqual({ starredAgentIds: ["c"], agentOrder: ["b", "a"] });
  });

  it("新增智能体追加普通区尾部", () => {
    const prefs = normalizeSidebarPrefs(["a", "b", "new"], {
      starredAgentIds: ["a"],
      agentOrder: ["b"],
    });
    expect(prefs).toEqual({ starredAgentIds: ["a"], agentOrder: ["b", "new"] });
  });
});

describe("toggleStarred", () => {
  it("加星：移入固定区尾部、移出普通区", () => {
    const next = toggleStarred({ starredAgentIds: ["a"], agentOrder: ["b", "c"] }, "b");
    expect(next).toEqual({ starredAgentIds: ["a", "b"], agentOrder: ["c"] });
  });

  it("去星：移回普通区尾部", () => {
    const next = toggleStarred({ starredAgentIds: ["a", "b"], agentOrder: ["c"] }, "a");
    expect(next).toEqual({ starredAgentIds: ["b"], agentOrder: ["c", "a"] });
  });
});

describe("reorderIds", () => {
  it("区内重排且索引越界夹取", () => {
    expect(reorderIds(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(reorderIds(["a", "b", "c"], 5, 0)).toEqual(["c", "a", "b"]);
    expect(reorderIds([], 0, 1)).toEqual([]);
  });
});

describe("groupConversations", () => {
  it("按 agent 分组；空 agentId 旧默认会话不展示；未知 agent 归孤儿", () => {
    const { byAgent, orphans } = groupConversations(
      [conv("1", "a"), conv("2", "a"), conv("3", ""), conv("4", "ghost")],
      new Set(["a"]),
    );
    expect([...byAgent.keys()]).toEqual(["a", "ghost"]);
    expect(byAgent.get("a")?.map((c) => c.id)).toEqual(["1", "2"]);
    expect(orphans.map((c) => c.id)).toEqual(["4"]);
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
