import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_TEXT_PREFIX,
  matchBuiltinToolCall,
} from "../../src/util/provider-tool-text.js";

describe("matchBuiltinToolCall（模型内置工具协议头识别）", () => {
  it("识别真实泄露样本（Z.ai analyze_image）", () => {
    const text =
      '**🌐 Z.ai Built-in Tool: analyze_image**\n\n**Input:**\n```json\n{"imageSource":"https://…}```';
    expect(matchBuiltinToolCall(text)).toBe("analyze_image");
  });

  it("识别无提供方空格变体", () => {
    expect(matchBuiltinToolCall("**🌐 Built-in Tool: web_search**")).toBe("web_search");
  });

  it("普通正文不误判", () => {
    expect(matchBuiltinToolCall("今天天气不错")).toBeNull();
    expect(matchBuiltinToolCall("**🌐 这个 emoji 用法演示**")).toBeNull();
    expect(matchBuiltinToolCall("前缀文本\n**🌐 Z.ai Built-in Tool: x**")).toBeNull();
  });

  it("流式拦截前缀常量为调用头首缀", () => {
    expect("**🌐 Z.ai Built-in Tool: analyze_image**".startsWith(BUILTIN_TOOL_TEXT_PREFIX)).toBe(
      true,
    );
  });
});
