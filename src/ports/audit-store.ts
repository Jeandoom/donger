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
  /** 按任务查全量审计事件（T17.3 观测面板数据源） */
  listByTask(taskId: string): Promise<AuditEvent[]>;
  listConversationSummaries(): Promise<AuditConversationSummary[]>;

  // ---- 纵深防御 L2（设计规格 §4）：用户面查询强制 viewer 过滤 ----
  /** 仅当会话属于 viewer 时返回其审计事件（否则空数组，含不存在） */
  listByConversationVisible(viewerId: string, conversationId: string): Promise<AuditEvent[]>;
  /** 仅当任务属于 viewer 时返回其审计事件（否则空数组，含不存在） */
  listByTaskVisible(viewerId: string, taskId: string): Promise<AuditEvent[]>;
}
