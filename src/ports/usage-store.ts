// 用量统计端口：捕获每次任务运行的 token 用量，支持按 用户/任务/时间 过滤查询。
// token-only，不含金额（见 docs/superpowers/specs/2026-06-30-usage-tracking-design.md）。

export interface UsageRecord {
  id: string;
  taskId: string;
  userId: string;
  channelId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** 四项之和，由 store 在 record 时算出 */
  totalTokens: number;
  /** ISO 时间，由 store 在 record 时写入 */
  recordedAt: string;
}

export interface UsageQuery {
  userId?: string;
  taskId?: string;
  /** ISO，inclusive */
  since?: string;
  /** ISO，inclusive */
  until?: string;
  /** 默认 100，上限 1000 */
  limit?: number;
}

export interface UsageStore {
  /** 调用方不传 totalTokens —— 由 store 据四项求和算出（不信任调用方）。 */
  record(r: Omit<UsageRecord, "id" | "recordedAt" | "totalTokens">): Promise<UsageRecord>;
  list(q?: UsageQuery): Promise<UsageRecord[]>;
}
