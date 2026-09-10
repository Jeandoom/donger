/** 门编排的纯逻辑（无 IO，供 orchestrator 调用）。
 * 三段式技能约定已退役：执行轮恒用 agent 全量 skills（SDK 按需调用），
 * 编排层只负责方案门/验收门的边界提示词与驳回熔断。 */

/** 驳回熔断上限：方案门/验收门各自驳回达到上限后任务终止（防无限重跑烧 token） */
export const MAX_DESIGN_REJECTIONS = 3;
export const MAX_ACCEPTANCE_REJECTIONS = 3;

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
