/**
 * 自动修复提案块解析（spec 2026-10-16-feedback-auto-dev-deploy-l2-design §4.2）。
 * MR 描述末尾的 ```donger-proposal fenced JSON 是 agent 的**线索**（feedbackId 关联、
 * 风险自述、测试证据展示），不是放行依据——放行判定只看真实 diff（release-policy.ts）。
 */
import { z } from "zod";

export const ReleaseProposalSchema = z.object({
  v: z.literal(1),
  /** 关联反馈 id（ReleaseService 回写反馈状态用；悬空无害） */
  feedbackId: z.string().min(1),
  kind: z.enum(["bugfix", "uxfix", "chore"]).default("bugfix"),
  riskNotes: z.string().max(2000).optional(),
  testEvidence: z.string().max(2000).optional(),
});
export type ReleaseProposal = z.infer<typeof ReleaseProposalSchema>;

const FENCE_RE = /```donger-proposal\s*\n([\s\S]*?)```/;

/** 提取并解析提案块；无块/JSON 非法/schema 不符一律返回 undefined（提案缺块=仅人工路径） */
export function parseReleaseProposal(mrBody: string | undefined): ReleaseProposal | undefined {
  if (!mrBody) return undefined;
  const match = FENCE_RE.exec(mrBody);
  if (!match?.[1]) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return undefined;
  }
  const parsed = ReleaseProposalSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
