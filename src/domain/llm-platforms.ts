// 预支持 LLM 平台注册表（单一事实源：设置页下拉、provider 校验、迁移反查共用）。
// sdkType="anthropic"：端点均为 Anthropic 协议兼容（SDK 经 ANTHROPIC_BASE_URL 消费）；
// sdkType="openai"：OpenAI 协议端点（chat/completions 形态），经 Codex Agent SDK +
// 内置 Responses↔Chat 桥原生接入（specs/2026-09-21-codex-openai-runner-design.md）；
// custom 平台二者可选（按 baseUrl 实际协议形态选择）。
export const LLM_SDK_TYPES = ["anthropic", "openai"] as const;
export type LlmSdkType = (typeof LLM_SDK_TYPES)[number];

export interface LlmPlatform {
  id: string;
  name: string;
  /** 平台预设 baseUrl；custom 为空串（用户必填） */
  baseUrl: string;
  /** 预填模型清单（保存后仍可编辑——各家上新模型无需发版） */
  models: string[];
  /** custom=true：baseUrl 必填、sdkType 可选；其余平台两者由注册表锁定 */
  custom: boolean;
  sdkType: LlmSdkType;
  /** UI 提示（如 qwen 端点无模型列表 API，探测 404 属正常） */
  note?: string;
}

export const LLM_PLATFORMS: readonly LlmPlatform[] = [
  {
    id: "zhipu-cn",
    name: "智谱 AI（中国版）",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    models: ["glm-4.6", "glm-4.5"],
    custom: false,
    sdkType: "anthropic",
  },
  {
    id: "zhipu-global",
    name: "智谱 AI（国际版 z.ai）",
    baseUrl: "https://api.z.ai/api/anthropic",
    models: ["glm-4.6", "glm-4.5"],
    custom: false,
    sdkType: "anthropic",
  },
  {
    id: "claude",
    name: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
    custom: false,
    sdkType: "anthropic",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    models: ["deepseek-chat", "deepseek-reasoner"],
    custom: false,
    sdkType: "anthropic",
  },
  {
    id: "qwen",
    name: "通义千问（百炼）",
    baseUrl: "https://dashscope.aliyuncs.com/api/v2/apps/anthropic",
    models: ["qwen3-coder-plus", "qwen3-max", "qwen-plus"],
    custom: false,
    sdkType: "anthropic",
    note: "百炼 Anthropic 端点不提供模型列表接口，「测试连接」探测返回 404 属正常",
  },
  {
    id: "qwen-coding",
    name: "通义千问（Coding Plan）",
    baseUrl: "https://coding.dashscope.aliyuncs.com/anthropic",
    models: ["qwen3-coder-plus"],
    custom: false,
    sdkType: "anthropic",
  },
  // —— OpenAI 协议平台（sdkType="openai"，CodexAgentRunner 引擎；specs/2026-09-21-codex-openai-runner-design.md）——
  // baseUrl 均为 chat/completions 形态根：codex 0.155+ 已移除 wire_api="chat"，
  // 全部经内置 Responses↔Chat 桥翻译（上游 key 留服务端，不进 agent 进程）。
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5.1", "gpt-5.1-codex", "gpt-4.1"],
    custom: false,
    sdkType: "openai",
  },
  {
    id: "deepseek-openai",
    name: "DeepSeek（OpenAI 协议）",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    custom: false,
    sdkType: "openai",
  },
  {
    id: "moonshot-openai",
    name: "Moonshot Kimi（OpenAI 协议）",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k2-turbo-preview", "kimi-k2-0905-preview"],
    custom: false,
    sdkType: "openai",
  },
  {
    id: "zhipu-openai",
    name: "智谱 AI（OpenAI 协议）",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-5.3-flash", "glm-4.6", "glm-4.5"],
    custom: false,
    sdkType: "openai",
  },
  {
    id: "custom",
    name: "自定义 / 网关",
    baseUrl: "",
    models: [],
    custom: true,
    sdkType: "anthropic",
    note: "自由填写 baseUrl：Anthropic 兼容端点或 OpenAI 协议端点（选 sdkType 决定引擎）",
  },
];

export function findLlmPlatform(id: string): LlmPlatform | undefined {
  return LLM_PLATFORMS.find((p) => p.id === id);
}

/** 归一化 baseUrl（去尾斜杠、小写 host 段）后与注册表精确匹配；未命中返回 undefined（迁移时落 custom）。 */
export function matchPlatformByBaseUrl(baseUrl: string): LlmPlatform | undefined {
  const normalized = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  if (!normalized) return undefined;
  return LLM_PLATFORMS.find((p) => p.baseUrl.toLowerCase() === normalized);
}
