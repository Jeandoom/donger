import type { LLMConfig } from "../domain/llm-config.js";

/** 对历史 SDK 输入做一次隔离的 LLM 调试调用。 */
export interface LlmDebugRunner {
  run(input: string, llm: LLMConfig): Promise<{ output: string }>;
}
