import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteAuditStore } from "../../src/adapters/sqlite-audit-store.js";
import type { AuditEvent } from "../../src/domain/types.js";

let db: Database.Database;
let store: SqliteAuditStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteAuditStore(db);
  store.migrate();
});
afterEach(() => db.close());

function ev(
  over: Partial<AuditEvent> & {
    conversationId: string;
    taskId: string;
    seq: number;
    type: AuditEvent["type"];
  },
): Omit<AuditEvent, "id"> {
  return { userId: "u1", recordedAt: "2026-07-01T00:00:00.000Z", ...over } as Omit<
    AuditEvent,
    "id"
  >;
}

describe("SqliteAuditStore", () => {
  it("migrate 幂等", () => {
    expect(() => store.migrate()).not.toThrow();
  });

  it("保存并读取完整 LLM input / output", async () => {
    await store.record(
      ev({
        conversationId: "c1",
        taskId: "t1",
        seq: 0,
        type: "llm_input",
        llmInput: '{"prompt":"hello","options":{"model":"m"}}',
      }),
    );
    await store.record(
      ev({
        conversationId: "c1",
        taskId: "t1",
        seq: 1,
        type: "llm_output",
        llmOutput: '{"type":"assistant","message":{"content":[]}}',
      }),
    );
    const events = await store.listByConversation("c1");
    expect(events[0]?.llmInput).toContain('"prompt"');
    expect(events[1]?.llmOutput).toContain('"assistant"');
  });

  it("record + listByConversation 往返，按 recordedAt,seq 升序", async () => {
    await store.record(
      ev({
        conversationId: "c1",
        taskId: "t1",
        seq: 0,
        type: "user_message",
        text: "hi",
        recordedAt: "2026-07-01T00:00:00.000Z",
      }),
    );
    await store.record(
      ev({
        conversationId: "c1",
        taskId: "t1",
        seq: 1,
        type: "text",
        text: "yo",
        recordedAt: "2026-07-01T00:00:01.000Z",
      }),
    );
    const list = await store.listByConversation("c1");
    expect(list.length).toBe(2);
    expect(list[0]?.seq).toBe(0);
    expect(list[0]?.text).toBe("hi");
  });

  it("listConversationSummaries 聚合", async () => {
    await store.record(
      ev({
        conversationId: "c1",
        taskId: "t1",
        seq: 0,
        type: "user_message",
        recordedAt: "2026-07-01T00:00:00.000Z",
      }),
    );
    await store.record(
      ev({
        conversationId: "c1",
        taskId: "t1",
        seq: 1,
        type: "result",
        resultSubtype: "success",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        durationMs: 1000,
        recordedAt: "2026-07-01T00:00:10.000Z",
      }),
    );
    const sums = await store.listConversationSummaries();
    expect(sums[0]).toMatchObject({
      conversationId: "c1",
      turnCount: 1,
      totalTokens: 15,
      totalDurationMs: 1000,
    });
  });

  it("listConversationSummaries 按 lastAt 倒序", async () => {
    await store.record(
      ev({
        conversationId: "c1",
        taskId: "t1",
        seq: 0,
        type: "user_message",
        recordedAt: "2026-07-01T00:00:00.000Z",
      }),
    );
    await store.record(
      ev({
        conversationId: "c2",
        taskId: "t2",
        seq: 0,
        type: "user_message",
        recordedAt: "2026-07-02T00:00:00.000Z",
      }),
    );
    const sums = await store.listConversationSummaries();
    expect(sums[0]?.conversationId).toBe("c2");
  });
});
