import type {
  TranscriptEntry,
  TranscriptKey,
  TranscriptSessionSummary,
  TranscriptStore,
} from "../ports/transcript-store.js";

interface CacheSegment {
  entries: TranscriptEntry[];
  uuids: Set<string>;
}

/**
 * TranscriptStore 宿主缓存装饰器（运行时性能轮 §长会话全量重建·档一）：
 * 按 (projectKey, sessionId, subpath) 缓存已解析条目数组——SDK resume 每轮 load() 的
 * 全表 SELECT + 逐条 JSON.parse 消掉，剩 IPC + CLI 侧物化（与本地 CLI resume 同性质）。
 * 一致性前提：本进程是 transcript 的唯一写者（donger 单实例单进程）——append 命中温缓存
 * 时增量追加（uuid 撞车=SDK 幂等重投，整段失效回库对齐，宁可多查一次不可多出一行）、
 * delete 失效同 session 全部 subpath；冷缓存不追踪（首次 load 拉全量后转温）。
 * 缓存有界（LRU，默认 50 个 session 段；0=禁用）；load 返回缓存数组本体，调用方不得变异
 * （SDK 侧只读消费；进程重启即整缓存清空，无跨进程一致性问题）。
 */
export class CachedTranscriptStore implements TranscriptStore {
  private readonly cache = new Map<string, CacheSegment>();

  constructor(
    private readonly inner: TranscriptStore,
    private readonly maxSessions = 50,
  ) {}

  private static cacheKey(key: TranscriptKey): string {
    return `${key.projectKey}\u0000${key.sessionId}\u0000${key.subpath ?? ""}`;
  }

  async append(
    key: TranscriptKey,
    conversationId: string,
    entries: TranscriptEntry[],
  ): Promise<void> {
    await this.inner.append(key, conversationId, entries);
    const ck = CachedTranscriptStore.cacheKey(key);
    const cached = this.cache.get(ck);
    if (!cached || entries.length === 0) return;
    // 幂等重投防御：uuid 已存在说明这批与库内可能重叠（INSERT OR IGNORE 会去重而缓存不会）
    // ——失效整段，下次 load 回库对齐
    if (entries.some((e) => e.uuid !== undefined && cached.uuids.has(e.uuid))) {
      this.cache.delete(ck);
      return;
    }
    cached.entries.push(...entries);
    for (const e of entries) if (e.uuid !== undefined) cached.uuids.add(e.uuid);
  }

  async load(key: TranscriptKey): Promise<TranscriptEntry[] | null> {
    const ck = CachedTranscriptStore.cacheKey(key);
    const cached = this.cache.get(ck);
    if (cached) {
      // LRU touch：delete+set 挪到队尾
      this.cache.delete(ck);
      this.cache.set(ck, cached);
      return cached.entries;
    }
    const loaded = await this.inner.load(key);
    if (loaded !== null) {
      this.set(ck, {
        entries: loaded,
        uuids: new Set(loaded.map((e) => e.uuid).filter((u): u is string => u !== undefined)),
      });
    }
    return loaded;
  }

  async listSessions(projectKey: string): Promise<TranscriptSessionSummary[]> {
    return this.inner.listSessions(projectKey);
  }

  async latestSessionForConversation(
    conversationId: string,
  ): Promise<TranscriptSessionSummary | null> {
    return this.inner.latestSessionForConversation(conversationId);
  }

  async listSubkeys(key: TranscriptKey): Promise<string[]> {
    return this.inner.listSubkeys(key);
  }

  async delete(key: TranscriptKey): Promise<void> {
    await this.inner.delete(key);
    const prefix = `${key.projectKey}\u0000${key.sessionId}\u0000`;
    for (const ck of [...this.cache.keys()]) {
      if (ck.startsWith(prefix)) this.cache.delete(ck);
    }
  }

  private set(ck: string, segment: CacheSegment): void {
    this.cache.delete(ck);
    this.cache.set(ck, segment);
    while (this.cache.size > this.maxSessions) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
