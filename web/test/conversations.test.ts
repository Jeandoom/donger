import { describe, expect, it } from "vitest";
import { isAgentConv, isDefaultConv } from "../src/lib/conversations";

describe("conversation filters", () => {
  it("isDefaultConv: agentId 为空串/undefined → true", () => {
    expect(isDefaultConv({ agentId: "" })).toBe(true);
    expect(isDefaultConv({})).toBe(true);
  });
  it("isDefaultConv: agentId 非空 → false", () => {
    expect(isDefaultConv({ agentId: "a1" })).toBe(false);
  });
  it("isAgentConv: agentId 匹配 → true", () => {
    expect(isAgentConv({ agentId: "a1" }, "a1")).toBe(true);
    expect(isAgentConv({ agentId: "a2" }, "a1")).toBe(false);
    expect(isAgentConv({}, "a1")).toBe(false);
  });
});
