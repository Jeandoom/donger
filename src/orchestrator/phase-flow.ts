/** 三段式生命周期阶段编排的纯逻辑（spec §5；无 IO，供 orchestrator 调用）。 */

export type PhaseKind = "design" | "execute" | "accept";

export interface PhaseStep {
  phase: PhaseKind;
  skills: string[];
}

export interface PhasePlan {
  steps: PhaseStep[];
  /** 验收门轻量规则（spec §5.3 修订）：有 *-accept skill 或 requiresDesign=true 才弹 */
  acceptanceGate: boolean;
}

/**
 * 按命名约定解析阶段：`*-design` / `*-execute` / `*-accept` 后缀匹配。
 * execute 无后缀匹配时回退全量 skills（兼容存量 agent）；
 * design 阶段在 requiresDesign=true 时始终存在（无 design skill 则空 skills，靠 agent 系统提示出方案）。
 */
export function resolvePhases(skills: string[], requiresDesign: boolean): PhasePlan {
  const design = skills.filter((s) => s.endsWith("-design"));
  const execute = skills.filter((s) => s.endsWith("-execute"));
  const accept = skills.filter((s) => s.endsWith("-accept"));

  const steps: PhaseStep[] = [];
  if (requiresDesign) steps.push({ phase: "design", skills: design });
  steps.push({ phase: "execute", skills: execute.length > 0 ? execute : skills });
  if (accept.length > 0) steps.push({ phase: "accept", skills: accept });

  return { steps, acceptanceGate: accept.length > 0 || requiresDesign };
}

export function designFirstAsk(prompt: string): string {
  return `${prompt}\n\n请先给出实施方案（不要执行）：目标、步骤、涉及文件、风险。方案经人工确认后才会执行。`;
}

export function designRejected(reason: string): string {
  return `方案被驳回：${reason}\n请根据驳回意见修改并重新输出完整方案（不要执行）。`;
}

export function executeAfterDesign(): string {
  return "方案已确认，开始按方案执行。";
}

export function executeRejected(reason: string): string {
  return `验收被驳回：${reason}\n请修复问题后重新执行并自验。`;
}

export function acceptAsk(): string {
  return "任务已执行完成，请自验并输出验收摘要：做了什么、结果如何、如何验证。";
}
