import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BufferedAuditStore } from "../../src/adapters/buffered-audit-store.js";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import type { AuditEvent } from "../../src/domain/types.js";

function ev(overrides: Partial<AuditEvent> & { seq: number }): Omit<AuditEvent, "id"> {
  return {
    conversationId: "conv-1",
    taskId: "task-1",
    userId: "user-1",
    type: "text",
    recordedAt: new Date().toISOString(),
    ...overrides,
  };
}

class FlakyInner extends InMemoryAuditStore {
  failNext = false;
  override async recordMany(events: AuditEvent[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("db locked");
    }
    await super.recordMany(events);
  }
}

describe("BufferedAuditStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("record 立即返回带 id 的事件，防抖窗口后批量落库且保序", async () => {
    const inner = new InMemoryAuditStore();
    const buffered = new BufferedAuditStore(inner, { flushIntervalMs: 50 });

    const recs = [];
    for (let seq = 0; seq < 3; seq++) recs.push(await buffered.record(ev({ seq })));
    // 立即返回：id 已分配、事件尚未落库
    expect(recs.every((r) => typeof r.id === "string")).toBe(true);
    await expect(inner.listByConversation("conv-1")).resolves.toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60);
    const stored = await inner.listByConversation("conv-1");
    expect(stored).toHaveLength(3);
    expect(stored.map((e) => e.seq)).toEqual([0, 1, 2]);
    // record 返回的 id 与落库行一致（同 id 直插，不二次生成）
    expect(stored.map((e) => e.id)).toEqual(recs.map((r) => r.id));
  });

  it("读路径先强制冲刷：未到防抖窗口也能读到刚 record 的事件", async () => {
    const inner = new InMemoryAuditStore();
    const buffered = new BufferedAuditStore(inner, { flushIntervalMs: 60_000 });

    await buffered.record(ev({ seq: 1 }));
    await expect(buffered.listByConversation("conv-1")).resolves.toHaveLength(1);
    await expect(buffered.maxSeq("conv-1")).resolves.toBe(1);
    // 读冲刷后 inner 已落库（「audit ≥ 实时流」对直接持有 inner 的读者同样成立）
    await expect(inner.listByConversation("conv-1")).resolves.toHaveLength(1);
  });

  it("队列溢出丢最旧、保最新（有界）", async () => {
    const inner = new InMemoryAuditStore();
    const buffered = new BufferedAuditStore(inner, { flushIntervalMs: 60_000, maxQueue: 2 });

    await buffered.record(ev({ seq: 1 }));
    await buffered.record(ev({ seq: 2 }));
    await buffered.record(ev({ seq: 3 }));

    const stored = await buffered.listByTask("task-1");
    expect(stored.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("批量落库失败整批重排队，下次冲刷成功（不静默丢）", async () => {
    const inner = new FlakyInner();
    inner.failNext = true;
    const buffered = new BufferedAuditStore(inner, { flushIntervalMs: 60_000 });

    await buffered.record(ev({ seq: 1 }));
    // 第一次冲刷失败：本次读不到，但事件已重排队、不静默丢弃
    await expect(buffered.listByConversation("conv-1")).resolves.toHaveLength(0);
    expect(inner.failNext).toBe(false);
    // 下一次冲刷成功，事件补上
    await expect(buffered.listByConversation("conv-1")).resolves.toHaveLength(1);
  });

  it("flush 收口：剩余事件全部落库", async () => {
    const inner = new InMemoryAuditStore();
    const buffered = new BufferedAuditStore(inner, { flushIntervalMs: 60_000 });
    await buffered.record(ev({ seq: 1 }));
    await buffered.record(ev({ seq: 2 }));
    await buffered.flush();
    await expect(inner.listByConversation("conv-1")).resolves.toHaveLength(2);
  });
});
