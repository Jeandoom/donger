import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { InMemoryUsageStore } from "../../src/adapters/in-memory-usage-store.js";
import { SqliteAuditStore } from "../../src/adapters/sqlite-audit-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteTaskStore } from "../../src/adapters/sqlite-task-store.js";
import { SqliteUsageStore } from "../../src/adapters/sqlite-usage-store.js";
import type { Task } from "../../src/domain/types.js";

/**
 * L2 纵深防御契约（设计规格 §4）：store 的 visible 查询强制 viewer 过滤——
 * 即使调用方绕过 HTTP 守卫，也拿不到他人的数据。
 * 两种实现（Sqlite=生产、InMemory=测试）同语义。
 */

const ALICE = "u-alice";
const BOB = "u-bob";

function makeTask(id: string, requesterId: string, status: Task["status"] = "done"): Task {
  const now = new Date().toISOString();
  return {
    id,
    channelId: "web",
    threadId: "conv-x",
    requesterId,
    prompt: `prompt-${id}`,
    status,
    skillChain: [],
    createdAt: now,
    updatedAt: now,
  };
}

describe("TaskStore visible（L2）", () => {
  it.each([
    ["in-memory", () => new InMemoryTaskStore()],
    [
      "sqlite",
      () => {
        const db = new Database(":memory:");
        const store = new SqliteTaskStore(db);
        store.migrate();
        return store;
      },
    ],
  ])("%s：非属主 getVisible → undefined；listVisible 只见本人", async (_name, make) => {
    const store = make();
    await store.create(makeTask("t-alice", ALICE));
    await store.create(makeTask("t-bob", BOB));
    await store.create(makeTask("t-run", ALICE, "running"));

    expect(await store.getVisible(ALICE, "t-alice")).toBeTruthy();
    expect(await store.getVisible(ALICE, "t-bob")).toBeUndefined();
    expect(await store.getVisible(BOB, "t-alice")).toBeUndefined();
    expect(await store.getVisible(ALICE, "t-ghost")).toBeUndefined();

    const aliceDone = await store.listVisible(ALICE, "done");
    expect(aliceDone.map((t) => t.id)).toEqual(["t-alice"]);
    const aliceRunning = await store.listVisible(ALICE, "running");
    expect(aliceRunning.map((t) => t.id)).toEqual(["t-run"]);
    const bobDone = await store.listVisible(BOB, "done");
    expect(bobDone.map((t) => t.id)).toEqual(["t-bob"]);
  });
});

describe("ConversationStore getVisible（L2）", () => {
  let db: Database.Database;
  let store: SqliteConversationStore;
  beforeEach(() => {
    db = new Database(":memory:");
    store = new SqliteConversationStore(db);
    store.migrate();
  });
  afterEach(() => db.close());

  it("非属主 getVisible → undefined", async () => {
    const conv = await store.create(ALICE, "web", "alice 会话");
    expect((await store.getVisible(ALICE, conv.id))?.id).toBe(conv.id);
    expect(await store.getVisible(BOB, conv.id)).toBeUndefined();
    expect(await store.getVisible(ALICE, "ghost")).toBeUndefined();
  });
});

describe("AuditStore visible（L2）", () => {
  const ev = (id: string, conversationId: string, taskId: string) => ({
    conversationId,
    taskId,
    userId: ALICE,
    seq: 1,
    type: "text" as const,
    text: `e-${id}`,
    recordedAt: new Date().toISOString(),
  });

  it("sqlite：join 属主校验，非属主/不存在 → 空数组", async () => {
    const db = new Database(":memory:");
    const convs = new SqliteConversationStore(db);
    convs.migrate();
    const tasks = new SqliteTaskStore(db);
    tasks.migrate();
    const audits = new SqliteAuditStore(db);
    audits.migrate();

    const conv = await convs.create(ALICE, "web", "c");
    await tasks.create(makeTask("t-alice", ALICE));
    await audits.record(ev("1", conv.id, "t-alice"));

    expect((await audits.listByConversationVisible(ALICE, conv.id)).length).toBe(1);
    expect(await audits.listByConversationVisible(BOB, conv.id)).toEqual([]);
    expect(await audits.listByConversationVisible(ALICE, "ghost")).toEqual([]);
    expect((await audits.listByTaskVisible(ALICE, "t-alice")).length).toBe(1);
    expect(await audits.listByTaskVisible(BOB, "t-alice")).toEqual([]);
    // 全量管理方法不受影响（对照）
    expect((await audits.listByConversation(conv.id)).length).toBe(1);
    db.close();
  });

  it("in-memory：未装配属主源 → visible 恒空（fail-closed）", async () => {
    const audits = new InMemoryAuditStore();
    await audits.record(ev("1", "conv-x", "t-x"));
    expect(await audits.listByConversationVisible(ALICE, "conv-x")).toEqual([]);
    expect(await audits.listByTaskVisible(ALICE, "t-x")).toEqual([]);
  });

  it("in-memory：装配属主源后按属主过滤", async () => {
    const audits = new InMemoryAuditStore({
      conversationOwner: async (id) => (id === "conv-alice" ? ALICE : undefined),
      taskOwner: async (id) => (id === "t-alice" ? ALICE : undefined),
    });
    await audits.record(ev("1", "conv-alice", "t-alice"));
    expect((await audits.listByConversationVisible(ALICE, "conv-alice")).length).toBe(1);
    expect(await audits.listByConversationVisible(BOB, "conv-alice")).toEqual([]);
    expect((await audits.listByTaskVisible(ALICE, "t-alice")).length).toBe(1);
    expect(await audits.listByTaskVisible(BOB, "t-alice")).toEqual([]);
  });
});

describe("UsageStore listByUser（L2）", () => {
  it.each([
    ["in-memory", () => new InMemoryUsageStore()],
    [
      "sqlite",
      () => {
        const db = new Database(":memory:");
        const store = new SqliteUsageStore(db);
        store.migrate();
        return store;
      },
    ],
  ])("%s：恒定按 userId 过滤", async (_name, make) => {
    const store = make();
    await store.record({
      conversationId: "c1",
      taskId: "t1",
      userId: ALICE,
      channelId: "web",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    await store.record({
      conversationId: "c2",
      taskId: "t2",
      userId: BOB,
      channelId: "web",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    const aliceOnly = await store.listByUser(ALICE);
    expect(aliceOnly.map((r) => r.userId)).toEqual([ALICE]);
    // 即便尝试查他人 id，listByUser 的 userId 参数恒定覆盖
    const forced = await store.listByUser(ALICE, {});
    expect(forced.map((r) => r.userId)).toEqual([ALICE]);
  });
});
