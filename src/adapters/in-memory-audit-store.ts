import type { AuditEvent } from "../domain/types.js";
import type { AuditConversationSummary, AuditStore } from "../ports/audit-store.js";

/** AuditStore 的内存实现（测试用；真实持久化见 SqliteAuditStore）。 */
export class InMemoryAuditStore implements AuditStore {
  private readonly byId = new Map<string, AuditEvent>();

  constructor(
    /** 会话/任务属主解析（L2 visible 查询用）。未提供时 visible 查询一律返回空（fail-closed） */
    private readonly ownerResolver?: {
      conversationOwner?: (id: string) => Promise<string | undefined>;
      taskOwner?: (id: string) => Promise<string | undefined>;
    },
  ) {}

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

  async listByConversationVisible(viewerId: string, conversationId: string): Promise<AuditEvent[]> {
    const owner = (await this.ownerResolver?.conversationOwner?.(conversationId)) ?? undefined;
    if (owner !== viewerId) return [];
    return this.listByConversation(conversationId);
  }

  async listByTaskVisible(viewerId: string, taskId: string): Promise<AuditEvent[]> {
    const owner = (await this.ownerResolver?.taskOwner?.(taskId)) ?? undefined;
    if (owner !== viewerId) return [];
    return this.listByTask(taskId);
  }

  async backfillToolUseInputs(
    conversationId: string,
    entries: Array<{ toolUseId: string; toolInput: string }>,
  ): Promise<number> {
    const byKey = new Map(entries.map((e) => [e.toolUseId, e.toolInput]));
    let updated = 0;
    for (const e of this.byId.values()) {
      if (
        e.conversationId === conversationId &&
        e.type === "tool_use" &&
        e.toolUseId &&
        byKey.has(e.toolUseId) &&
        (e.toolInput === undefined || e.toolInput === "{}")
      ) {
        e.toolInput = byKey.get(e.toolUseId);
        updated += 1;
      }
    }
    return updated;
  }

  async maxSeq(conversationId: string): Promise<number> {
    let max = -1;
    for (const e of this.byId.values()) {
      if (e.conversationId === conversationId && e.seq > max) max = e.seq;
    }
    return max;
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

  async listConversationSummariesVisible(viewerId: string): Promise<AuditConversationSummary[]> {
    const all = await this.listConversationSummaries();
    const visible: AuditConversationSummary[] = [];
    for (const s of all) {
      const owner = (await this.ownerResolver?.conversationOwner?.(s.conversationId)) ?? undefined;
      if (owner === viewerId) visible.push(s);
    }
    return visible;
  }

  async searchByKeyword(keyword: string, limit: number): Promise<AuditEvent[]> {
    return [...this.byId.values()]
      .filter((e) => e.text?.includes(keyword))
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
      .slice(0, limit);
  }

  async searchByKeywordVisible(
    viewerId: string,
    keyword: string,
    limit: number,
  ): Promise<AuditEvent[]> {
    const out: AuditEvent[] = [];
    const ownerCache = new Map<string, string | undefined>();
    for (const e of [...this.byId.values()].sort((a, b) =>
      b.recordedAt.localeCompare(a.recordedAt),
    )) {
      if (!e.text?.includes(keyword)) continue;
      if (!ownerCache.has(e.conversationId)) {
        ownerCache.set(
          e.conversationId,
          (await this.ownerResolver?.conversationOwner?.(e.conversationId)) ?? undefined,
        );
      }
      if (ownerCache.get(e.conversationId) !== viewerId) continue;
      out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** kb_search 0 命中统计（R-E）：按 toolUseId 关联 tool_result 判空命中 */
  async kbSearchStats(limit = 500): Promise<{ total: number; zeroHit: number }> {
    const uses = [...this.byId.values()]
      .filter((e) => e.type === "tool_use" && e.toolName === "mcp__donger-kb__kb_search")
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
      .slice(0, limit);
    let total = 0;
    let zeroHit = 0;
    for (const use of uses) {
      if (!use.toolUseId) continue;
      total++;
      const result = [...this.byId.values()].find(
        (e) => e.type === "tool_result" && e.toolUseId === use.toolUseId,
      );
      const output = result?.toolOutput ?? "";
      if (output.includes('"hits":[]') || output.includes("（无命中")) zeroHit++;
    }
    return { total, zeroHit };
  }
}
