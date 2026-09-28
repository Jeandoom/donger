// Agent SDK（执行引擎）标识：anthropic→Claude Code SDK、openai→Codex Agent SDK、
// zcode→ZCode CLI（引擎路由见 src/domain/llm-platforms.ts，此为 web 端单一展示源）。

export type LlmSdkType = "anthropic" | "openai" | "zcode";

export const LLM_SDK_LABEL: Record<LlmSdkType, string> = {
  anthropic: "Claude Code SDK",
  openai: "Codex Agent SDK",
  zcode: "ZCode CLI",
};

/** 徽标配色：三引擎一色一档，一眼区分（未知值回退 neutral） */
export const LLM_SDK_TONE: Record<LlmSdkType, "primary" | "warning" | "info"> = {
  anthropic: "primary",
  openai: "warning",
  zcode: "info",
};

export function llmSdkLabel(sdkType?: string): string | undefined {
  return sdkType && sdkType in LLM_SDK_LABEL ? LLM_SDK_LABEL[sdkType as LlmSdkType] : undefined;
}

export function llmSdkTone(sdkType?: string): "primary" | "warning" | "info" | "neutral" {
  return sdkType && sdkType in LLM_SDK_TONE ? LLM_SDK_TONE[sdkType as LlmSdkType] : "neutral";
}
