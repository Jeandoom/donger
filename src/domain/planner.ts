/**
 * 任务规划：把入口消息映射到一个「能力包」（skill 集合，交 agent 自主编排），
 * 而非有序步骤链。编码能力复用用户级 superpowers 插件的 skill
 * （brainstorm → plan → TDD → verify 工作流），donger 不自造编码 skill。
 */

export interface Intent {
  name: string;
  triggers: string[];
  /** 该意图启用 的 skill 集合（能力包，交 runner 加载） */
  skills: string[];
}

export interface Plan {
  intent: string;
  skills: string[];
}

/** superpowers 编码能力包：触发代码任务时启用，agent 按 superpowers 工作流自主推进 */
const CODING_BUNDLE: readonly string[] = [
  "superpowers:brainstorming",
  "superpowers:writing-plans",
  "superpowers:test-driven-development",
  "superpowers:systematic-debugging",
  "superpowers:executing-plans",
  "superpowers:verification-before-completion",
  "superpowers:using-git-worktrees",
  "superpowers:subagent-driven-development",
];

const DEFAULT_INTENTS: readonly Intent[] = [
  {
    name: "code",
    triggers: ["代码", "实现", "接口", "函数", "bug", "重构", "compile", "测试"],
    skills: [...CODING_BUNDLE],
  },
];

export class Planner {
  constructor(private readonly intents: readonly Intent[] = DEFAULT_INTENTS) {}

  plan(text: string): Plan {
    const lower = text.toLowerCase();
    const hit = this.intents.find((i) => i.triggers.some((t) => lower.includes(t.toLowerCase())));
    return hit ? { intent: hit.name, skills: [...hit.skills] } : { intent: "general", skills: [] };
  }
}
