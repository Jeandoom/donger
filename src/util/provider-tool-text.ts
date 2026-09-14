/**
 * 模型服务端内置工具协议文本（如 Z.ai/GLM 的 analyze_image）：
 * 调用过程以 markdown 协议块混在正文流里（"**🌐 Z.ai Built-in Tool: analyze_image**" + Input JSON），
 * 其中常带云存储预签名 URL（含本地路径 + Signature）。此处提供识别与折叠所需的纯函数。
 */

/** 内置工具调用头的特征前缀（流式增量按此做分块拦截） */
export const BUILTIN_TOOL_TEXT_PREFIX = "**🌐";

/** 匹配内置工具调用头，返回工具名；非协议块返回 null。
 *  示例： "**🌐 Z.ai Built-in Tool: analyze_image**" → "analyze_image" */
export function matchBuiltinToolCall(text: string): string | null {
  const m = /^\*\*🌐\s*\S*\s*Built-in Tool:\s*([A-Za-z_][\w.-]*)\*\*/.exec(text);
  return m?.[1] ?? null;
}
