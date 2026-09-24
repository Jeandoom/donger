import type { LlmSdkType } from "./llm-platforms.js";

// LLM 端点配置（独立可配置：支持按任务/全局切换 GLM、Qwen 等）。
// baseUrl 指向 Anthropic 兼容端点（如智谱 https://open.bigmodel.cn/api/anthropic）。
// sdkType 决定执行引擎路由（specs/2026-09-21-codex-openai-runner-design.md §6）：
//   anthropic（缺省）→ ClaudeAgentRunner（ANTHROPIC_BASE_URL 直连）
//   openai           → CodexAgentRunner（恒经内置 Responses↔Chat 桥，上游 key 不进 agent 进程）
export interface LLMConfig {
  model: string;
  baseUrl: string;
  authToken: string;
  /** 缺省 anthropic：存量 .env/preset 构造不必显式携带 */
  sdkType?: LlmSdkType;
}
