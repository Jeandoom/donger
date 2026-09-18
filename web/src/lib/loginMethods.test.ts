import { describe, expect, it } from "vitest";
import { parseLoginMethods } from "./loginMethods";

describe("parseLoginMethods", () => {
  it("过滤非法项并按 邮箱>钉钉>GitHub 优先级排序", () => {
    expect(parseLoginMethods(["github", "bogus", "email", "dingtalk"])).toEqual([
      "email",
      "dingtalk",
      "github",
    ]);
  });

  it("重复项去重", () => {
    expect(parseLoginMethods(["email", "email"])).toEqual(["email"]);
  });

  it("空数组 = 服务端明确未配置任何方式 → 原样返回（不兜底）", () => {
    expect(parseLoginMethods([])).toEqual([]);
  });

  it("非数组（探测失败）→ 回退邮箱保底", () => {
    expect(parseLoginMethods(null)).toEqual(["email"]);
    expect(parseLoginMethods(undefined)).toEqual(["email"]);
    expect(parseLoginMethods({ methods: ["github"] })).toEqual(["email"]);
  });

  it("fallback 可自定义", () => {
    expect(parseLoginMethods(null, [])).toEqual([]);
  });
});
