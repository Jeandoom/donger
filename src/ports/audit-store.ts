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
  /** id 可选传入（BufferedAuditStore 入队时预分配，保证 record 返回值与落库行 id 一致） */
  record(e: Omit<AuditEvent, "id"> & { id?: string }): Promise<AuditEvent>;
  /** 批量落库（审计缓冲刷盘用）：单事务保序插入，空数组无操作 */
  recordMany(events: AuditEvent[]): Promise<void>;
  listByConversation(conversationId: string): Promise<AuditEvent[]>;
  /** 按任务查全量审计事件（T17.3 观测面板数据源） */
  listByTask(taskId: string): Promise<AuditEvent[]>;
  listConversationSummaries(): Promise<AuditConversationSummary[]>;

  // ---- zcode 轮末对账（specs/2026-09-29-zcode-record-fidelity-design.md M1）----
  /** 回填 tool_use 行真实入参：仅命中 toolInput 为 '{}' 或 NULL 的行（幂等，不覆盖已有值）。
   *  返回实际更新行数。 */
  backfillToolUseInputs(
    conversationId: string,
    entries: Array<{ toolUseId: string; toolInput: string }>,
  ): Promise<number>;
  /** 会话审计事件当前最大 seq（对账合成缺失行时取序） */
  maxSeq(conversationId: string): Promise<number>;

  // ---- 纵深防御 L2（设计规格 §4）：用户面查询强制 viewer 过滤 ----
  /** 仅当会话属于 viewer 时返回其审计事件（否则空数组，含不存在） */
  listByConversationVisible(viewerId: string, conversationId: string): Promise<AuditEvent[]>;
  /** 仅当任务属于 viewer 时返回其审计事件（否则空数组，含不存在） */
  listByTaskVisible(viewerId: string, taskId: string): Promise<AuditEvent[]>;
  /** 仅返回属于 viewer 的会话审计汇总（经 conversations.userId 判属主） */
  listConversationSummariesVisible(viewerId: string): Promise<AuditConversationSummary[]>;

  // ---- 关键词检索（donger-audit 工具）：admin 全量 / member visible 成对提供 ----
  /** 全量事件 text 关键词检索（LIKE，含转义），按时间倒序截 limit 条 */
  searchByKeyword(keyword: string, limit: number): Promise<AuditEvent[]>;
  /** 仅检索属于 viewer 的会话事件 text 关键词检索（同样经 conversations.userId 收口） */
  searchByKeywordVisible(viewerId: string, keyword: string, limit: number): Promise<AuditEvent[]>;

  /**
   * kb_search 0 命中统计（R-E：检索质量信号，向量层触发依据）：
   * 近 limit 次 kb_search 调用中 0 命中的次数（tool_result 空 hits / 旧格式无命中标记）。
   */
  kbSearchStats(limit?: number): Promise<{ total: number; zeroHit: number }>;
}
