// 会话执行审计端口：持久化每轮事件流，按 conversationId 查询/聚合。
// 详见 docs/superpowers/specs/2026-07-01-conversation-audit-design.md
import type { AuditEvent } from "../domain/types.js";

export interface AuditConversationSummary {
  conversationId: string;
  /** prompts 数量 = 不同 taskId 数（一轮 = 一个用户 prompt） */
  turnCount: number;
  /** 该会话所有 result 事件 usage 四项之和 */
  totalTokens: number;
  /** 各轮 durationMs 之和 */
  totalDurationMs: number;
  firstAt: string;
  lastAt: string;
}

export interface AuditStore {
  record(e: Omit<AuditEvent, "id">): Promise<AuditEvent>;
  listByConversation(conversationId: string): Promise<AuditEvent[]>;
  listConversationSummaries(): Promise<AuditConversationSummary[]>;
}
