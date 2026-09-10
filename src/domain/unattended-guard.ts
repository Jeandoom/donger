import type { Agent } from "./agent.js";

export type UnattendedCheck = { safe: true } | { safe: false; reason: string };

/**
 * 无人值守安全校验（定时/hook 触发的 workflow 启用前调用）：
 * agent 启用验收门（acceptanceGate）时，任务会在验收门等待人工决议（requiresDesign 的
 * 方案门由 dispatcher 运行时判定，静态检查无法覆盖，由无人值守执行策略另行约束），
 * 无人值守场景无人应答 → 任务挂起直至超时失败。启用前拒绝并给出修复建议。
 */
export function checkUnattendedSafety(
  agent: Pick<Agent, "name" | "acceptanceGate">,
): UnattendedCheck {
  if (agent.acceptanceGate) {
    return {
      safe: false,
      reason: `智能体「${agent.name}」启用了验收门（acceptanceGate），无人值守任务会卡在验收门等待人工决议；请关闭验收门后再启用定时任务，或改用交互会话执行`,
    };
  }
  return { safe: true };
}
