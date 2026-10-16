import type { ReleaseVerdict } from "../domain/release-policy.js";

/** 自动发布执行记录生命周期（spec 2026-10-16-feedback-auto-dev-deploy-l2-design §4.5）：
 * needs_human（策略拒绝转人工）→ merged（已自动合并，待宿主管线发布）→ deployed / rolled_back；
 * merge_failed（平台合并调用失败）可重试（下次 tick 视为未处理？不——记录在案等人工，防重复合并语义歧义）。
 * 行按 (repositoryPath, mrNumber) 唯一：同一 MR 终身一行，状态只前进。 */
export type ReleaseRunStatus =
  | "needs_human"
  | "merged"
  | "merge_failed"
  | "deployed"
  | "rolled_back";

export interface ReleaseRun {
  id: string;
  workflowId: string;
  /** 来源工作流执行（事件触发的 run；手动/无关联为空） */
  workflowRunId: string | null;
  /** 提案块关联的反馈（悬空无害） */
  feedbackId: string | null;
  repositoryPath: string;
  mrNumber: string;
  mrUrl: string;
  sourceBranch: string;
  headSha: string;
  baseSha: string;
  /** evaluateReleaseProposal 完整判定（含 reasons/warnings），JSON 字符串 */
  policyVerdict: string;
  status: ReleaseRunStatus;
  /** 宿主管线回报的镜像 tag / 失败原因等附加信息（JSON 字符串，可空） */
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseRunStore {
  migrate(): void;
  insert(run: ReleaseRun): Promise<void>;
  get(id: string): Promise<ReleaseRun | undefined>;
  /** 同 MR 去重键（终身一行） */
  getByMr(repositoryPath: string, mrNumber: string): Promise<ReleaseRun | undefined>;
  /** 宿主管线按镜像内嵌 sha 回报定位（headSha 不区分大小写） */
  getByHeadSha(repositoryPath: string, headSha: string): Promise<ReleaseRun | undefined>;
  listByWorkflow(workflowId: string, limit?: number): Promise<ReleaseRun[]>;
  listAll(limit?: number): Promise<ReleaseRun[]>;
  updateStatus(
    id: string,
    status: ReleaseRunStatus,
    patch?: { detail?: string; policyVerdict?: string },
  ): Promise<void>;
}
