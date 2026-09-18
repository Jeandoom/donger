/**
 * LLM 模型引用（modelRef）的三种形态与解析。
 * - "system"                    —— .env 全局默认（LLM_MODEL + ANTHROPIC_BASE_URL/TOKEN）
 * - "preset:<id>"               —— .env AGENT_LLM_PRESETS 预设（id 为下标字符串）
 * - "provider:<providerId>:<model>" —— 用户自建 provider（user_llm_providers）的某一模型
 */
export type ModelRef =
  | { kind: "system" }
  | { kind: "preset"; id: string }
  | {
      kind: "provider";
      providerId: string;
      model: string;
    };

export const SYSTEM_MODEL_REF = "system";

/** 解析引用字符串；格式非法返回 undefined（调用方决定报错或静默降级）。 */
export function parseModelRef(raw: string): ModelRef | undefined {
  if (raw === SYSTEM_MODEL_REF) return { kind: "system" };
  if (raw.startsWith("preset:")) {
    const id = raw.slice("preset:".length).trim();
    return id ? { kind: "preset", id } : undefined;
  }
  if (raw.startsWith("provider:")) {
    const rest = raw.slice("provider:".length);
    // providerId 为 UUID（含连字符不含冒号），model 取最后一个冒号后的段（模型名理论上不含冒号）
    const sep = rest.lastIndexOf(":");
    if (sep <= 0 || sep === rest.length - 1) return undefined;
    const providerId = rest.slice(0, sep);
    const model = rest.slice(sep + 1);
    return providerId && model ? { kind: "provider", providerId, model } : undefined;
  }
  return undefined;
}

export function isModelRef(raw: string): boolean {
  return parseModelRef(raw) !== undefined;
}
