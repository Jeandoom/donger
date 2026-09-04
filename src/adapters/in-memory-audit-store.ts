import type { AuditEvent } from "../domain/types.js";
import type { AuditConversationSummary, AuditStore } from "../ports/audit-store.js";

/** AuditStore 的内存实现（测试用；真实持久化见 SqliteAuditStore）。 */
export class InMemoryAuditStore implements AuditStore {
  private readonly byId = new Map<string, AuditEvent>();

  async record(e: Omit<AuditEvent, "id">): Promise<AuditEvent> {
    const rec: AuditEvent = { ...e, id: crypto.randomUUID() };
    this.byId.set(rec.id, rec);
    return rec;
  }

  async listByConversation(conversationId: string): Promise<AuditEvent[]> {
    return [...this.byId.values()]
      .filter((e) => e.conversationId === conversationId)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.seq - b.seq);
  }

  async listByTask(taskId: string): Promise<AuditEvent[]> {
    return [...this.byId.values()]
      .filter((e) => e.taskId === taskId)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.seq - b.seq);
  }

  async listConversationSummaries(): Promise<AuditConversationSummary[]> {
    const byConv = new Map<string, AuditEvent[]>();
    for (const e of this.byId.values()) {
      const arr = byConv.get(e.conversationId) ?? [];
      arr.push(e);
      byConv.set(e.conversationId, arr);
    }
    return [...byConv.entries()]
      .map(([conversationId, events]) => {
        const sorted = events.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
        const tasks = new Set(events.map((e) => e.taskId));
        let totalTokens = 0;
        let totalDurationMs = 0;
        for (const e of events) {
          if (e.type === "result" && e.usage) {
            totalTokens +=
              e.usage.inputTokens +
              e.usage.outputTokens +
              e.usage.cacheCreationInputTokens +
              e.usage.cacheReadInputTokens;
          }
          if (e.type === "result" && typeof e.durationMs === "number")
            totalDurationMs += e.durationMs;
        }
        return {
          conversationId,
          turnCount: tasks.size,
          totalTokens,
          totalDurationMs,
          firstAt: sorted[0]?.recordedAt ?? "",
          lastAt: sorted[sorted.length - 1]?.recordedAt ?? "",
        };
      })
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }
}
