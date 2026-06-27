import { describe, expect, it } from "vitest";

// 工具链冒烟测试：确认 Vitest + TS 配置可用。
describe("sanity", () => {
  it("工具链可用", () => {
    expect(1 + 1).toBe(2);
  });
});
