import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import type { AuditEvent } from "../../src/domain/types.js";

function ev(
  over: Partial<AuditEvent> & {
    conversationId: string;
    taskId: string;
    seq: number;
    type: AuditEvent["type"];
  },
): Omit<AuditEvent, "id"> {
  return {
    userId: "u1",
    recordedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  } as Omit<AuditEvent, "id">;
}

describe("InMemoryAuditStore", () => {
  it("record 写回 id", async () => {
    const s = new InMemoryAuditStore();
    const r = await s.record(
      ev({ conversationId: "c1", taskId: "t1", seq: 0, type: "user_message", text: "hi" }),
    );
    expect(r.id).toBeTruthy();
    expect(r.conversationId).toBe("c1");
  });

  it("listByConversation 按 recordedAt,seq 升序（跨轮次按时间）", async () => {
    const s = new InMemoryAuditStore();
    await s.record(
      ev({
        conversationId: "c1",
        taskId: "t1",
        seq: 0,
        type: "user_message",
        recordedAt: "2026-07-01T00:00:00.000Z",
      }),
    );
    await s.record(
      ev({
        conversationId: "c1",
        taskId: "t1",
        seq: 1,
        type: "text",
        text: "a",
        recordedAt: "2026-07-01T00:00:01.000Z",
      }),
    );
    await s.record(
      ev({
        conversationId: "c2",
        taskId: "t2",
        seq: 0,
        type: "user_message",
        recordedAt: "2026-07-01T00:00:02.000Z",
      }),
    );
    const list = await s.listByConversation("c1");
    expect(list.length).toBe(2);
    expect(list[0]?.seq).toBe(0);
    expect(list[1]?.seq).toBe(1);
  });

  it("listConversationSummaries 聚合 turnCount/totalTokens/totalDurationMs/firstAt/lastAt", async () => {
    const s = new InMemoryAuditStore();
    await s.record(
      ev({
        conversationId: "c1",
        taskId: "t1",
        seq: 0,
        type: "user_message",
        recordedAt: "2026-07-01T00:00:00.000Z",
      }),
    );
    await s.record(
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
    const sums = await s.listConversationSummaries();
    expect(sums.length).toBe(1);
    expect(sums[0]).toMatchObject({
      conversationId: "c1",
      turnCount: 1,
      totalTokens: 15,
      totalDurationMs: 1000,
      firstAt: "2026-07-01T00:00:00.000Z",
      lastAt: "2026-07-01T00:00:10.000Z",
    });
  });

  it("listConversationSummaries 多轮 turnCount = 不同 taskId 数", async () => {
    const s = new InMemoryAuditStore();
    await s.record(
      ev({ conversationId: "c1", taskId: "t1", seq: 0, type: "user_message", recordedAt: "t1" }),
    );
    await s.record(
      ev({ conversationId: "c1", taskId: "t2", seq: 0, type: "user_message", recordedAt: "t2" }),
    );
    expect((await s.listConversationSummaries())[0]?.turnCount).toBe(2);
  });
});
