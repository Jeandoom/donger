/**
 * 宿主管线结果回报契约（spec 2026-10-16-feedback-auto-dev-deploy-l2-design §4.6/4.7）。
 * watcher/host-release 脚本经 POST /api/internal/release-result 上报（Bearer token 鉴权）。
 * 状态映射：deployed→反馈 resolved；rolled_back→反馈回 accepted+管理员高优通知；
 * build_failed→生产未被触碰（切换前失败），release_run 维持 merged、仅记 detail。
 */
import { z } from "zod";

export const ReleaseResultSchema = z.object({
  repositoryPath: z.string().min(1).max(300),
  headSha: z.string().regex(/^[0-9a-f]{7,40}$/i),
  status: z.enum(["deployed", "rolled_back", "build_failed"]),
  imageTag: z.string().max(200).optional(),
  reason: z.string().max(2000).optional(),
  /** 演练/生产槽标识（观测用） */
  slot: z.string().max(64).optional(),
});
export type ReleaseResult = z.infer<typeof ReleaseResultSchema>;

/** 结果 → 反馈状态（存储枚举零迁移；build_failed 不动反馈） */
export function feedbackStatusFor(result: ReleaseResult): "resolved" | "accepted" | null {
  if (result.status === "deployed") return "resolved";
  if (result.status === "rolled_back") return "accepted";
  return null;
}
