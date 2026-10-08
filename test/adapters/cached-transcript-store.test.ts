import { describe, expect, it } from "vitest";
import { CachedTranscriptStore } from "../../src/adapters/cached-transcript-store.js";
import type {
  TranscriptEntry,
  TranscriptKey,
  TranscriptSessionSummary,
  TranscriptStore,
} from "../../src/ports/transcript-store.js";

/** 计数桩：记录 load 调用次数，其余内存语义与 SqliteTranscriptStore 对齐 */
class CountingStore implements TranscriptStore {
  loadCalls = 0;
  private readonly rows = new Map<string, TranscriptEntry[]>();

  private static k(key: TranscriptKey): string {
    return `${key.projectKey}\u0000${key.sessionId}\u0000${key.subpath ?? ""}`;
  }

  async append(
    key: TranscriptKey,
    _conversationId: string,
    entries: TranscriptEntry[],
  ): Promise<void> {
    const ck = CountingStore.k(key);
    const existing = this.rows.get(ck) ?? [];
    // 与 SqliteTranscriptStore 同契约：uuid 冲突忽略（INSERT OR IGNORE）
    const seen = new Set(existing.map((e) => e.uuid));
    const fresh = entries.filter((e) => e.uuid === undefined || !seen.has(e.uuid));
    this.rows.set(ck, [...existing, ...fresh]);
  }

  async load(key: TranscriptKey): Promise<TranscriptEntry[] | null> {
    this.loadCalls += 1;
    return this.rows.get(CountingStore.k(key)) ?? null;
  }

  async listSessions(): Promise<TranscriptSessionSummary[]> {
    return [];
  }

  async latestSessionForConversation(): Promise<TranscriptSessionSummary | null> {
    return null;
  }

  async listSubkeys(): Promise<string[]> {
    return [];
  }

  async delete(key: TranscriptKey): Promise<void> {
    const prefix = `${key.projectKey}\u0000${key.sessionId}\u0000`;
    for (const ck of [...this.rows.keys()]) {
      if (ck.startsWith(prefix)) this.rows.delete(ck);
    }
  }
}

const key = (sessionId: string, subpath?: string): TranscriptKey => ({
  projectKey: "user-1",
  sessionId,
  subpath,
});

const entry = (n: number): TranscriptEntry => ({ type: "user", uuid: `u${n}`, n });

describe("CachedTranscriptStore（档一：宿主 transcript 缓存）", () => {
  it("load 缓存命中：同 key 只打一次 inner，append 增量并入温缓存", async () => {
    const inner = new CountingStore();
    const cached = new CachedTranscriptStore(inner);

    await cached.append(key("s1"), "conv-1", [entry(1)]);
    expect(await cached.load(key("s1"))).toHaveLength(1);
    expect(inner.loadCalls).toBe(1);

    // 第二轮 resume：命中缓存，不再全量 SELECT+parse
    expect(await cached.load(key("s1"))).toHaveLength(1);
    expect(inner.loadCalls).toBe(1);

    // SDK 镜像双写落新条目：温缓存增量追加，后续 load 免查询且内容完整
    await cached.append(key("s1"), "conv-1", [entry(2), entry(3)]);
    const third = await cached.load(key("s1"));
    expect(third).toHaveLength(3);
    expect(inner.loadCalls).toBe(1);
  });

  it("冷缓存不追踪 append：首次 load 拉全量后转温（重启后语义）", async () => {
    const inner = new CountingStore();
    const cached = new CachedTranscriptStore(inner);

    await cached.append(key("s1"), "conv-1", [entry(1)]);
    // 未 load 过就 append：缓存无此 key，append 不凭空造缓存
    expect(await cached.load(key("s1"))).toHaveLength(1);
    expect(inner.loadCalls).toBe(1);
  });

  it("delete 失效同 session 全部 subpath 缓存", async () => {
    const inner = new CountingStore();
    const cached = new CachedTranscriptStore(inner);

    await cached.append(key("s1"), "conv-1", [entry(1)]);
    await cached.append(key("s1", "sub-a"), "conv-1", [entry(2)]);
    await cached.load(key("s1"));
    await cached.load(key("s1", "sub-a"));
    expect(inner.loadCalls).toBe(2);

    await cached.delete(key("s1"));
    await cached.append(key("s1"), "conv-1", [entry(3)]);
    expect(await cached.load(key("s1"))).toHaveLength(1);
    expect(inner.loadCalls).toBe(3);
  });

  it("LRU 有界：超限逐出最久未用段", async () => {
    const inner = new CountingStore();
    const cached = new CachedTranscriptStore(inner, 1);

    await cached.append(key("s1"), "conv-1", [entry(1)]);
    await cached.append(key("s2"), "conv-1", [entry(2)]);
    await cached.load(key("s1"));
    await cached.load(key("s2")); // s1 被逐出
    expect(inner.loadCalls).toBe(2);

    await cached.load(key("s1")); // 未命中，重新拉
    expect(inner.loadCalls).toBe(3);
  });

  it("空会话（null）不缓存", async () => {
    const inner = new CountingStore();
    const cached = new CachedTranscriptStore(inner);

    expect(await cached.load(key("none"))).toBeNull();
    expect(await cached.load(key("none"))).toBeNull();
    expect(inner.loadCalls).toBe(2);
  });

  it("uuid 撞车（SDK 幂等重投）整段失效回库对齐，缓存不多行", async () => {
    const inner = new CountingStore();
    const cached = new CachedTranscriptStore(inner);

    await cached.append(key("s1"), "conv-1", [entry(1)]);
    await cached.load(key("s1"));
    expect(inner.loadCalls).toBe(1);

    // 同 uuid 重投：库侧 INSERT OR IGNORE 去重，缓存侧失效
    await cached.append(key("s1"), "conv-1", [entry(1)]);
    expect(await cached.load(key("s1"))).toHaveLength(1);
    expect(inner.loadCalls).toBe(2);
  });

  it("maxSessions=0 禁用缓存（退化为透传）", async () => {
    const inner = new CountingStore();
    const cached = new CachedTranscriptStore(inner, 0);
    await cached.append(key("s1"), "conv-1", [entry(1)]);
    await cached.load(key("s1"));
    await cached.load(key("s1"));
    expect(inner.loadCalls).toBe(2);
  });
});
