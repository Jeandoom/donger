// LLM 端点配置（独立可配置：支持按任务/全局切换 GLM、Qwen 等）。
// baseUrl 指向 Anthropic 兼容端点（如智谱 https://open.bigmodel.cn/api/anthropic）。
export interface LLMConfig {
  model: string;
  baseUrl: string;
  authToken: string;
}
