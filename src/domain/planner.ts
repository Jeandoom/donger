/**
 * 任务规划：仅识别意图。技能选择改由 Pack 驱动（见 domain/skill-resolution.ts），
 * donger 不再在 Planner 里维护 skill 集合。
 */

export interface Intent {
  name: string;
  triggers: string[];
}

export interface Plan {
  intent: string;
}

const DEFAULT_INTENTS: readonly Intent[] = [
  { name: "code", triggers: ["代码", "实现", "接口", "函数", "bug", "重构", "compile", "测试"] },
];

export class Planner {
  constructor(private readonly intents: readonly Intent[] = DEFAULT_INTENTS) {}

  plan(text: string): Plan {
    const lower = text.toLowerCase();
    const hit = this.intents.find((i) => i.triggers.some((t) => lower.includes(t.toLowerCase())));
    return { intent: hit ? hit.name : "general" };
  }
}
