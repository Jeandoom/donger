import type { Agent } from "./agent.js";

export type UnattendedCheck = { safe: true } | { safe: false; reason: string };

/**
 * 无人值守安全校验（定时/hook 触发的 workflow 启用前调用）：
 * agent 技能含 `*-accept` 后缀时，任务会触发验收门等待人工决议（resolvePhases 约定），
 * 无人值守场景无人应答 → 任务永久挂起并占用会话。启用前拒绝并给出修复建议。
 */
export function checkUnattendedSafety(agent: Pick<Agent, "name" | "skills">): UnattendedCheck {
  const acceptSkills = agent.skills.filter((s) => s.endsWith("-accept"));
  if (acceptSkills.length > 0) {
    return {
      safe: false,
      reason: `智能体「${agent.name}」技能含验收门技能（${acceptSkills.join("、")}），无人值守任务会卡在验收门等待人工决议；请移除 accept 技能后再启用定时任务，或改用交互会话执行`,
    };
  }
  return { safe: true };
}
