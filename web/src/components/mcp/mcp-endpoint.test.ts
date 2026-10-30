import { describe, expect, it } from "vitest";
import { resolveEndpoint } from "./McpSection";

describe("resolveEndpoint（MCP 端点统一解析）", () => {
  it("服务端返回公开地址时优先采用（PUBLIC_BASE_URL 已配置）", () => {
    expect(resolveEndpoint("https://donger.jeandom.cc:3330/mcp", "https://10.0.0.5:3330")).toBe(
      "https://donger.jeandom.cc:3330/mcp",
    );
  });

  it("服务端回退 HOST（0.0.0.0）时按浏览器 origin 推导", () => {
    expect(resolveEndpoint("https://0.0.0.0:3330/mcp", "https://donger.jeandom.cc:3330")).toBe(
      "https://donger.jeandom.cc:3330/mcp",
    );
  });

  it("服务端回退 localhost（开发环境）时按浏览器 origin 推导", () => {
    expect(resolveEndpoint("http://localhost:3410/mcp", "http://localhost:3410")).toBe(
      "http://localhost:3410/mcp",
    );
  });

  it("服务端未启用（null）时按浏览器 origin 推导", () => {
    expect(resolveEndpoint(null, "https://donger.jeandom.cc:3330")).toBe(
      "https://donger.jeandom.cc:3330/mcp",
    );
  });

  it("origin 尾斜杠不产生双斜杠", () => {
    expect(resolveEndpoint(null, "https://donger.jeandom.cc:3330/")).toBe(
      "https://donger.jeandom.cc:3330/mcp",
    );
  });
});
