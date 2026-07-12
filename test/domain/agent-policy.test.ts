import { describe, it, expect } from "vitest";
import { canManageAgent, canUseAgent } from "../../src/domain/agent-policy.js";
import type { Agent } from "../../src/domain/agent.js";

const agent: Agent = {
  id: "a1",
  ownerId: "owner",
  name: "x",
  skills: [],
  tools: { mode: "all", whitelist: [] },
  mcpServers: [],
  llm: {},
  createdAt: "",
  updatedAt: "",
};

describe("agent policy", () => {
  it("owner 可管理", () => {
    expect(canManageAgent(agent, { id: "owner", role: "user" })).toBe(true);
  });
  it("admin 可管理任意", () => {
    expect(canManageAgent(agent, { id: "other", role: "admin" })).toBe(true);
  });
  it("陌生用户不可管理", () => {
    expect(canManageAgent(agent, { id: "other", role: "user" })).toBe(false);
  });
  it("owner 可用，无需 grant", () => {
    expect(canUseAgent(agent, { id: "owner", role: "user" }, false)).toBe(true);
  });
  it("被授权 stranger 可用", () => {
    expect(canUseAgent(agent, { id: "stranger", role: "user" }, true)).toBe(true);
  });
  it("未授权 stranger 不可用", () => {
    expect(canUseAgent(agent, { id: "stranger", role: "user" }, false)).toBe(false);
  });
});
