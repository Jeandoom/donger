/** 处理登记（幂等键）端口（spec 2026-10-30-workflow-dedup-design.md §4.1）：
 * 工作流对业务项（如 TB taskId）「只处理一次」的平台硬约束——
 * claim 为原子认领（INSERT OR IGNORE），同键并发仅一胜者。 */

export interface WorkflowDedupEntry {
  workflowId: string;
  dedupKey: string;
  runId: string;
  status: "claimed" | "released";
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDedupClaimResult {
  /** true=首次认领（本轮应处理）；false=已被认领（existing 为既有条目） */
  claimed: boolean;
  existing?: WorkflowDedupEntry;
}

export interface WorkflowDedupStore {
  migrate(): void;
  /** 原子认领：同键并发仅一胜者。已存在（含 released 后重认领覆盖）返回既有条目 */
  claim(
    workflowId: string,
    dedupKey: string,
    runId: string,
    note?: string,
  ): Promise<WorkflowDedupClaimResult>;
  get(workflowId: string, dedupKey: string): Promise<WorkflowDedupEntry | undefined>;
  /** 释放（claimed→released）：释放后可重认领。无 claimed 行返回 false */
  release(workflowId: string, dedupKey: string, note?: string): Promise<boolean>;
  /** 登记列表（管理面/详情页），createdAt 倒序 */
  list(workflowId: string, opts?: { limit?: number }): Promise<WorkflowDedupEntry[]>;
}
