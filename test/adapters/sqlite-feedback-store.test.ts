import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteFeedbackStore } from "../../src/adapters/sqlite-feedback-store.js";
import type { Feedback } from "../../src/domain/feedback.js";

function makeFeedback(
  id: string,
  userId: string,
  createdAt: string,
  overrides?: Partial<Feedback>,
): Feedback {
  return {
    id,
    userId,
    category: "ui",
    content: `content-${id}`,
    images: [],
    status: "open",
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe("SqliteFeedbackStore", () => {
  let store: SqliteFeedbackStore;
  beforeEach(() => {
    const db = new Database(":memory:");
    store = new SqliteFeedbackStore(db);
    store.migrate();
  });

  it("create/get 往返：images JSON 序列化无感", async () => {
    await store.create(
      makeFeedback("fb-1", "u-1", "2026-09-20T10:00:00Z", { images: ["a.png", "b.jpg"] }),
    );
    const fb = await store.get("fb-1");
    expect(fb?.userId).toBe("u-1");
    expect(fb?.category).toBe("ui");
    expect(fb?.status).toBe("open");
    expect(fb?.images).toEqual(["a.png", "b.jpg"]);
    expect(await store.get("ghost")).toBeUndefined();
  });

  it("毒 images JSON 兜底为空数组不抛错", async () => {
    const db = new Database(":memory:");
    const s = new SqliteFeedbackStore(db);
    s.migrate();
    db.prepare(
      "INSERT INTO feedback_items (id, userId, category, content, images, status, createdAt, updatedAt) VALUES ('fb-x','u','ui','c','not-json','open','t','t')",
    ).run();
    expect((await s.get("fb-x"))?.images).toEqual([]);
  });

  it("listByUser 仅本人、listAll 全量，均 createdAt 倒序", async () => {
    await store.create(makeFeedback("fb-a1", "u-a", "2026-09-20T10:00:00Z"));
    await store.create(makeFeedback("fb-a2", "u-a", "2026-09-20T11:00:00Z"));
    await store.create(makeFeedback("fb-b1", "u-b", "2026-09-20T09:00:00Z"));

    const alice = await store.listByUser("u-a");
    expect(alice.map((f) => f.id)).toEqual(["fb-a2", "fb-a1"]);
    const all = await store.listAll();
    expect(all.map((f) => f.id)).toEqual(["fb-a2", "fb-a1", "fb-b1"]);
  });

  it("updateStatus 流转并 bump updatedAt", async () => {
    await store.create(makeFeedback("fb-1", "u-1", "2026-09-20T10:00:00Z"));
    await store.updateStatus("fb-1", "accepted");
    const fb = await store.get("fb-1");
    expect(fb?.status).toBe("accepted");
    expect(fb?.updatedAt).not.toBe("2026-09-20T10:00:00Z");
  });

  it("replies 正序返回，addReply 同时 bump 主项 updatedAt", async () => {
    await store.create(makeFeedback("fb-1", "u-1", "2026-09-20T10:00:00Z"));
    await store.addReply({
      id: "r-2",
      feedbackId: "fb-1",
      userId: "u-admin",
      authorRole: "admin",
      content: "second",
      createdAt: "2026-09-20T11:00:00Z",
    });
    await store.addReply({
      id: "r-1",
      feedbackId: "fb-1",
      userId: "u-1",
      authorRole: "user",
      content: "first",
      createdAt: "2026-09-20T10:30:00Z",
    });

    const replies = await store.listReplies("fb-1");
    expect(replies.map((r) => r.id)).toEqual(["r-1", "r-2"]);
    expect((await store.get("fb-1"))?.updatedAt).toBe("2026-09-20T11:00:00Z");
  });
});
