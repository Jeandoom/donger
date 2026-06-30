import type { UsageQuery, UsageRecord, UsageStore } from "../ports/usage-store.js";

/** UsageStore 的内存实现（测试用；真实持久化见 SqliteUsageStore）。 */
export class InMemoryUsageStore implements UsageStore {
  private readonly byId = new Map<string, UsageRecord>();

  async record(r: Omit<UsageRecord, "id" | "recordedAt" | "totalTokens">): Promise<UsageRecord> {
    const totalTokens =
      r.inputTokens + r.outputTokens + r.cacheCreationInputTokens + r.cacheReadInputTokens;
    const rec: UsageRecord = {
      ...r,
      id: crypto.randomUUID(),
      totalTokens,
      recordedAt: new Date().toISOString(),
    };
    this.byId.set(rec.id, rec);
    return rec;
  }

  async list(q: UsageQuery = {}): Promise<UsageRecord[]> {
    let rows = [...this.byId.values()];
    if (q.userId) rows = rows.filter((r) => r.userId === q.userId);
    if (q.taskId) rows = rows.filter((r) => r.taskId === q.taskId);
    const since = q.since;
    if (since) rows = rows.filter((r) => r.recordedAt >= since);
    const until = q.until;
    if (until) rows = rows.filter((r) => r.recordedAt <= until);
    rows.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    const limit = Math.min(q.limit ?? 100, 1000);
    return rows.slice(0, limit);
  }
}
