import type { AuditEvent } from "../domain/types.js";
import type { AuditConversationSummary, AuditStore } from "../ports/audit-store.js";

/**
 * AuditStore 缓冲装饰器（运行时性能轮 §审计异步化，specs/runtime-perf）：
 * record 同步入队立即返回，防抖窗口内的事件合并为一次批量事务落库（inner.recordMany）。
 * 既有时序不变量全部保留：
 * - 「audit ≥ 实时流」对读者成立——所有读路径先强制 flush 再查（回放/审计页/zcode 对账都走读面）；
 * - 顺序保真——队列 FIFO，seq 由调用方内联分配天然保序，批量按入队序插入；
 * - 失败不静默——刷盘异常把整批重排队（有界）并记日志，下个窗口重试。
 * 代价：崩溃丢失窗口从 0 变为一个刷盘周期（默认 75ms）；关停路径由 index.ts shutdown
 * 显式 flush() 收口。裸 fire-and-forget 已否决（破回放不变量）——本装饰器不是它。
 */
export class BufferedAuditStore implements AuditStore {
  private pending: AuditEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private droppedTotal = 0;

  constructor(
    private readonly inner: AuditStore,
    private readonly options: { flushIntervalMs?: number; maxQueue?: number } = {},
  ) {}

  private get flushIntervalMs(): number {
    return this.options.flushIntervalMs ?? 75;
  }

  private get maxQueue(): number {
    return this.options.maxQueue ?? 2000;
  }

  record(e: Omit<AuditEvent, "id"> & { id?: string }): Promise<AuditEvent> {
    const rec: AuditEvent = { ...e, id: e.id ?? crypto.randomUUID() };
    if (this.pending.length >= this.maxQueue) {
      this.pending.shift();
      this.droppedTotal += 1;
      // 限频告警：持续溢出时不刷屏（第 1 条与之后每 100 条各记一次）
      if (this.droppedTotal % 100 === 1) {
        console.warn(
          `[audit-buffer] 队列溢出，已丢弃最旧事件（累计 ${this.droppedTotal} 条）——落库持续慢于产出`,
        );
      }
    }
    this.pending.push(rec);
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.flushIntervalMs);
    }
    return Promise.resolve(rec);
  }

  /** 强制把队列落库；读路径与关停路径调用。失败重排队，不抛出。 */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    try {
      await this.inner.recordMany(batch);
    } catch (error) {
      this.pending = [...batch, ...this.pending].slice(-this.maxQueue);
      console.error(`[audit-buffer] 批量落库失败，${batch.length} 条已重新排队重试`, error);
    }
  }

  /** 读前冲刷兜底：保证缓冲中的事件对本次读可见。 */
  private async drained<T>(read: () => Promise<T>): Promise<T> {
    await this.flush();
    return read();
  }

  async recordMany(events: AuditEvent[]): Promise<void> {
    await this.flush();
    await this.inner.recordMany(events);
  }

  listByConversation(conversationId: string): Promise<AuditEvent[]> {
    return this.drained(() => this.inner.listByConversation(conversationId));
  }

  listByTask(taskId: string): Promise<AuditEvent[]> {
    return this.drained(() => this.inner.listByTask(taskId));
  }

  listConversationSummaries(): Promise<AuditConversationSummary[]> {
    return this.drained(() => this.inner.listConversationSummaries());
  }

  backfillToolUseInputs(
    conversationId: string,
    entries: Array<{ toolUseId: string; toolInput: string }>,
  ): Promise<number> {
    // 回填要 UPDATE 的行可能还在缓冲里，先冲刷再委托
    return this.drained(() => this.inner.backfillToolUseInputs(conversationId, entries));
  }

  maxSeq(conversationId: string): Promise<number> {
    return this.drained(() => this.inner.maxSeq(conversationId));
  }

  listByConversationVisible(viewerId: string, conversationId: string): Promise<AuditEvent[]> {
    return this.drained(() => this.inner.listByConversationVisible(viewerId, conversationId));
  }

  listByTaskVisible(viewerId: string, taskId: string): Promise<AuditEvent[]> {
    return this.drained(() => this.inner.listByTaskVisible(viewerId, taskId));
  }

  listConversationSummariesVisible(viewerId: string): Promise<AuditConversationSummary[]> {
    return this.drained(() => this.inner.listConversationSummariesVisible(viewerId));
  }

  searchByKeyword(keyword: string, limit: number): Promise<AuditEvent[]> {
    return this.drained(() => this.inner.searchByKeyword(keyword, limit));
  }

  searchByKeywordVisible(viewerId: string, keyword: string, limit: number): Promise<AuditEvent[]> {
    return this.drained(() => this.inner.searchByKeywordVisible(viewerId, keyword, limit));
  }

  kbSearchStats(limit?: number): Promise<{ total: number; zeroHit: number }> {
    return this.drained(() => this.inner.kbSearchStats(limit));
  }
}
