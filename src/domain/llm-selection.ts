import type { UserLlmProvider } from "./user-llm-provider.js";

export interface LlmOption {
  /** 下发前端后原样回传（POST messages 的 modelRef） */
  ref: string;
  label: string;
  group: "system" | "preset" | "provider";
}

export interface ResolveLlmOptionsInput {
  /** 当前用户（访问者）的 provider 列表——共享 agent 场景下也按访问者解析 */
  providers: Pick<UserLlmProvider, "id" | "name" | "models">[];
  /** 结构兼容 config.LlmPreset（鸭子类型，保持 domain 不依赖顶层 config） */
  presets: { id: string; name: string; model: string }[];
  systemDefaultModel: string;
}

/**
 * 解析会话可选模型集（specs/2026-09-18-llm-multi-provider-design.md §8）：
 * system + 全部 presets + 当前用户全部 provider 模型，恒为全量。
 * （agent 侧的 presetId/modelRefs 模型范围配置已退役，
 * 见 specs/2026-09-21-agent-config-llm-removal-skills-tree-design.md。）
 */
export function resolveLlmOptions(input: ResolveLlmOptionsInput): LlmOption[] {
  const options: LlmOption[] = [];
  if (input.systemDefaultModel) {
    options.push({
      ref: "system",
      label: `系统默认（${input.systemDefaultModel}）`,
      group: "system",
    });
  }
  for (const preset of input.presets) {
    options.push({
      ref: `preset:${preset.id}`,
      label: `${preset.name}（${preset.model}）`,
      group: "preset",
    });
  }
  for (const provider of input.providers) {
    for (const model of provider.models) {
      options.push({
        ref: `provider:${provider.id}:${model}`,
        label: `${provider.name} / ${model}`,
        group: "provider",
      });
    }
  }
  return options;
}
