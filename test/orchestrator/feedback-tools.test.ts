import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { SqliteFeedbackStore } from "../../src/adapters/sqlite-feedback-store.js";
import type { Feedback } from "../../src/domain/feedback.js";
import {
  type FeedbackToolsDeps,
  feedbackStatusAdvance,
  feedbackToolDefinitions,
} from "../../src/orchestrator/feedback-tools.js";
import type { NotificationService } from "../../src/orchestrator/notification-service.js";

function makeStore(): SqliteFeedbackStore {
  const db = new Database(":memory:");
  const store = new SqliteFeedbackStore(db);
  store.migrate();
  return store;
}

function seedFeedback(store: SqliteFeedbackStore, over: Partial<Feedback> = {}): Feedback {
  const fb: Feedback = {
    id: "fb-1",
    userId: "submitter-1",
    category: "logic",
    content: "导出按钮点了没反应",
    images: [],
    conversationIds: [],
    status: "open",
    createdAt: "2026-10-20T00:00:00Z",
    updatedAt: "2026-10-20T00:00:00Z",
    ...over,
  };
  void store.create(fb);
  return fb;
}

function makeDeps(
  store: SqliteFeedbackStore,
  over: {
    viewerId?: string;
    notifications?: NotificationService;
    allowedFeedbackId?: string;
  } = {},
): FeedbackToolsDeps {
  return {
    viewer: { id: over.viewerId ?? "admin-1" },
    feedbackStore: store,
    notifications: over.notifications,
    allowedFeedbackId: over.allowedFeedbackId ?? "fb-1",
  };
}

/** 测试口径的 ToolResult（SDK 联合类型窄化太弱，本地收拢） */
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function tool(
  deps: FeedbackToolsDeps,
  name: string,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  const def = feedbackToolDefinitions(deps).find((t) => t.name === name);
  if (!def) throw new Error(`tool not found: ${name}`);
  return (args) => def.handler(args as never, {} as never) as Promise<ToolResult>;
}

describe("反馈状态机单向递增", () => {
  it("合法推进 / 幂等 / 回退拒绝", () => {
    expect(feedbackStatusAdvance("open", "accepted")).toBe("ok");
    expect(feedbackStatusAdvance("accepted", "resolved")).toBe("ok");
    expect(feedbackStatusAdvance("open", "closed")).toBe("ok");
    expect(feedbackStatusAdvance("resolved", "resolved")).toBe("same");
    expect(feedbackStatusAdvance("resolved", "accepted")).toBe("backward");
    expect(feedbackStatusAdvance("closed", "open")).toBe("backward");
  });
});

describe("donger-feedback 工具（correlation 写边界 + 沉淀 + 状态推进）", () => {
  it("写边界：操作 correlation 之外的反馈单一律拒绝", async () => {
    const store = makeStore();
    seedFeedback(store);
    seedFeedback(store, { id: "fb-other", userId: "submitter-2" });
    const deps = makeDeps(store);

    const reply = await tool(
      deps,
      "feedback_add_reply",
    )({
      feedbackId: "fb-other",
      content: "越权写入",
    });
    expect(reply.isError).toBe(true);
    expect(reply.content[0]?.text).toContain("拒绝写入其他反馈单");
    expect(await store.listReplies("fb-other")).toEqual([]);

    const get = await tool(deps, "feedback_get")({ feedbackId: "fb-other" });
    expect(get.isError).toBe(true);
  });

  it("add_reply：system 角色落库 + feedback.replied 通知提交人 + markStatus 推进", async () => {
    const store = makeStore();
    seedFeedback(store);
    const notify = vi.fn().mockResolvedValue({});
    const deps = makeDeps(store, { notifications: { notify } as unknown as NotificationService });

    const r = await tool(
      deps,
      "feedback_add_reply",
    )({
      feedbackId: "fb-1",
      content: "已定位为事件监听缺失，修复已合入。",
      markStatus: "resolved",
    });
    expect(r.isError).toBeUndefined();

    const replies = await store.listReplies("fb-1");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.authorRole).toBe("system");
    expect(replies[0]?.userId).toBe("admin-1");
    expect((await store.get("fb-1"))?.status).toBe("resolved");

    expect(notify).toHaveBeenCalledTimes(1);
    const intent = notify.mock.calls[0]?.[0] as {
      event: string;
      recipients: unknown[];
      link: string;
    };
    expect(intent.event).toBe("feedback.replied");
    expect(intent.recipients).toEqual([{ kind: "user", userId: "submitter-1" }]);
    expect(intent.link).toBe("/feedback?focus=fb-1");
  });

  it("add_reply：回退 markStatus 被拒但回复仍落库；状态相同时幂等；提交人本人处理不通知", async () => {
    const store = makeStore();
    seedFeedback(store, { status: "closed" });
    const notify = vi.fn().mockResolvedValue({});
    const deps = makeDeps(store, {
      notifications: { notify } as unknown as NotificationService,
      viewerId: "submitter-1",
    });

    const r = await tool(
      deps,
      "feedback_add_reply",
    )({
      feedbackId: "fb-1",
      content: "结论",
      markStatus: "accepted",
    });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toContain("回退");
    expect((await store.get("fb-1"))?.status).toBe("closed");
    expect(await store.listReplies("fb-1")).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();

    const again = await tool(
      deps,
      "feedback_add_reply",
    )({
      feedbackId: "fb-1",
      content: "再次结论",
      markStatus: "closed",
    });
    expect(again.content[0]?.text).toContain("状态已是 closed");
  });

  it("update_status：推进/幂等/回退三分支", async () => {
    const store = makeStore();
    seedFeedback(store);
    const deps = makeDeps(store);

    const ok1 = await tool(
      deps,
      "feedback_update_status",
    )({
      feedbackId: "fb-1",
      status: "accepted",
    });
    expect(ok1.content[0]?.text).toContain("open → accepted");

    const same = await tool(
      deps,
      "feedback_update_status",
    )({
      feedbackId: "fb-1",
      status: "accepted",
    });
    expect(same.content[0]?.text).toContain("状态已是 accepted");

    const back = await tool(
      deps,
      "feedback_update_status",
    )({
      feedbackId: "fb-1",
      status: "open",
    });
    expect(back.isError).toBe(true);
    expect(back.content[0]?.text).toContain("不允许回退");
  });

  it("get：返回反馈详情与回复时间线；不存在的单子报错", async () => {
    const store = makeStore();
    seedFeedback(store);
    const deps = makeDeps(store);
    await store.addReply({
      id: "r1",
      feedbackId: "fb-1",
      userId: "submitter-1",
      authorRole: "user",
      content: "补充截图",
      createdAt: "2026-10-20T01:00:00Z",
    });

    const got = await tool(deps, "feedback_get")({ feedbackId: "fb-1" });
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      feedback: { id: string };
      replies: unknown[];
    };
    expect(body.feedback.id).toBe("fb-1");
    expect(body.replies).toHaveLength(1);

    const missing = await tool(deps, "feedback_get")({ feedbackId: "fb-nope" });
    expect(missing.isError).toBe(true);
  });
});
