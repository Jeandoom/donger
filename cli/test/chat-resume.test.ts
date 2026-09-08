import { describe, expect, it } from "vitest";
import { filterResumeScope, filterTasksScope } from "../src/chat.js";
import type { AgentSummary, ConversationSummary } from "../src/types.js";

const conv = (
  id: string,
  agentId: string,
  updatedAt: string,
  archived?: boolean,
): ConversationSummary => ({
  id,
  userId: "u1",
  title: `t-${id}`,
  channelId: "cli",
  agentId,
  createdAt: updatedAt,
  updatedAt,
  archived,
});

const agent = (id: string, name: string): AgentSummary => ({ id, name, _mine: true });

describe("filterResumeScope", () => {
  const list = [
    conv("c1", "a1", "2026-09-08T09:00:00Z"),
    conv("c2", "a2", "2026-09-08T10:00:00Z"),
    conv("c3", "a1", "2026-09-08T08:00:00Z"),
    conv("c4", "a1", "2026-09-08T11:00:00Z", true), // 归档：任何视图都不出现
    conv("c5", "", "2026-09-08T07:00:00Z"), // 默认会话（chat）
  ];

  it("chat 上下文：全部未归档会话，updatedAt 倒序", () => {
    const r = filterResumeScope(list, null, "");
    expect(r.scope).toBe("all");
    expect(r.items.map((c) => c.id)).toEqual(["c2", "c1", "c3", "c5"]);
  });

  it("agent 上下文：仅该 agent 的会话", () => {
    const r = filterResumeScope(list, agent("a1", "甲"), "");
    expect(r.scope).toBe("agent");
    expect(r.items.map((c) => c.id)).toEqual(["c1", "c3"]);
  });

  it("agent 上下文 + all：解除过滤看全部", () => {
    const r = filterResumeScope(list, agent("a1", "甲"), "all");
    expect(r.scope).toBe("all");
    expect(r.items).toHaveLength(4);
  });

  it("agent 上下文无匹配会话：返回空列表（由调用方给出路提示）", () => {
    const r = filterResumeScope(list, agent("nobody", "无"), "");
    expect(r.scope).toBe("agent");
    expect(r.items).toHaveLength(0);
  });
});

describe("filterTasksScope", () => {
  const t = (id: string, requesterId: string, threadId: string) => ({ id, requesterId, threadId });
  const tasks = [
    t("k1", "u1", "conv1"),
    t("k2", "u2", "conv1"), // 他人任务：始终排除（后端无用户隔离，CLI 自救）
    t("k3", "u1", "conv2"),
  ];

  it("chat 上下文（conversationId 空）：仅按用户过滤", () => {
    expect(filterTasksScope(tasks, "u1", "", "").map((x) => x.id)).toEqual(["k1", "k3"]);
  });

  it("agent 上下文：收窄到当前会话", () => {
    expect(filterTasksScope(tasks, "u1", "conv1", "").map((x) => x.id)).toEqual(["k1"]);
  });

  it("all：解除全部过滤（含他人任务）", () => {
    expect(filterTasksScope(tasks, "u1", "conv1", "all")).toHaveLength(3);
  });
});
