import { z } from "zod";

/** 流水线步骤角色：dispatcher 路由 / builder 补建 / chat 闲聊 / agent 业务执行 */
export const FlowRoleSchema = z.enum(["dispatcher", "builder", "chat", "agent"]);
export type FlowRole = z.infer<typeof FlowRoleSchema>;

export const FlowStepStatusSchema = z.enum(["running", "done", "failed", "canceled"]);
export type FlowStepStatus = z.infer<typeof FlowStepStatusSchema>;

/** Task Flow 步骤：task.steps[] 串联一个请求的完整处理链（方案 A：全部挂用户当前会话） */
export const FlowStepSchema = z.object({
  seq: z.number().int().nonnegative(),
  role: FlowRoleSchema,
  agentId: z.string().min(1),
  conversationId: z.string().min(1),
  status: FlowStepStatusSchema,
  /** dispatcher=路由理由 / builder=创建内容 / chat|agent=结果摘要 */
  summary: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
});
export type FlowStep = z.infer<typeof FlowStepSchema>;

/**
 * 开新步骤（不可变返回新数组）：seq 取末尾 +1，状态 running。
 * 调用方随即将返回的 steps 落到 task（store.updateStatus patch.steps）。
 */
export function beginStep(
  steps: FlowStep[],
  init: { role: FlowRole; agentId: string; conversationId: string; startedAt: string },
): FlowStep[] {
  const seq = steps.length > 0 ? (steps[steps.length - 1]?.seq ?? 0) + 1 : 0;
  return [...steps, { seq, status: "running", ...init }];
}

/**
 * 收尾处于 running 状态的步骤（默认最后一个；status 默认 done）。
 * 无 running 步骤时原样返回（幂等，防御重复收尾）。
 */
export function completeStep(
  steps: FlowStep[],
  opts: { summary?: string; status?: FlowStepStatus } = {},
): FlowStep[] {
  let idx = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]?.status === "running") {
      idx = i;
      break;
    }
  }
  if (idx < 0) return steps;
  return steps.map((s, i) =>
    i === idx ? { ...s, status: opts.status ?? "done", summary: opts.summary ?? s.summary } : s,
  );
}
