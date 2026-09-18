import type { Agent } from "./agent.js";
import type { UserLlmProvider } from "./user-llm-provider.js";

export interface LlmOption {
  /** 下发前端后原样回传（POST messages 的 modelRef） */
  ref: string;
  label: string;
  group: "system" | "preset" | "provider";
}

export interface ResolveLlmOptionsInput {
  agent?: Pick<Agent, "llm"> | null;
  /** 当前用户（访问者）的 provider 列表——共享 agent 的 owner 引用天然不在其中（过滤降级） */
  providers: Pick<UserLlmProvider, "id" | "name" | "models">[];
  /** 结构兼容 config.LlmPreset（鸭子类型，保持 domain 不依赖顶层 config） */
  presets: { id: string; name: string; model: string }[];
  systemDefaultModel: string;
}

export interface LlmOptions {
  options: LlmOption[];
  /** true=agent 配置了模型范围（restricted）；false=全量可选 */
  restricted: boolean;
}

/**
 * agent 的模型范围引用。只取 modelRefs——presetId 语义是「默认模型」（优先级链 ③）
 * 而非限制：只配了 presetId 的存量 agent 不构成范围（用户从未被限制选模型）。
 */
export function agentModelRefs(agent: Pick<Agent, "llm"> | null | undefined): string[] {
  return agent?.llm.modelRefs ?? [];
}

/**
 * 解析会话可选模型集（specs/2026-09-18-llm-multi-provider-design.md §8）。
 * - agent 配置了范围（modelRefs/presetId 非空）：逐条解析，preset 失效剔除、provider 引用
 *   不属于当前用户（共享降级）或模型不在清单内则剔除；**全部被剔除视为未配置**（全量）
 * - 未配置范围：system + 全部 presets + 当前用户全部 provider 模型
 */
export function resolveLlmOptions(input: ResolveLlmOptionsInput): LlmOptions {
  const allOptions = buildAllOptions(input);
  const refs = agentModelRefs(input.agent);
  if (refs.length === 0) return { options: allOptions, restricted: false };

  const restricted: LlmOption[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    const option = allOptions.find((o) => o.ref === ref);
    if (option) {
      seen.add(ref);
      restricted.push(option);
    }
  }
  // 全部失效（如共享 agent 只引了 owner 的 provider）：按未配置处理，避免会话无模型可选
  if (restricted.length === 0) return { options: allOptions, restricted: false };
  return { options: restricted, restricted: true };
}

function buildAllOptions(input: ResolveLlmOptionsInput): LlmOption[] {
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

/** 范围校验：ref 是否在 agent 范围解析结果内（消息 modelRef 越界拦截用）。 */
export function isRefAllowed(agent: Pick<Agent, "llm"> | null | undefined, ref: string): boolean {
  const refs = agentModelRefs(agent);
  if (refs.length === 0) return true;
  return refs.includes(ref);
}
