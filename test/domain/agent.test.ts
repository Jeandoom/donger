import { describe, expect, it } from "vitest";
import { AgentSchema, parseAgent } from "../../src/domain/agent.js";

const valid = {
  id: "a1",
  ownerId: "u1",
  name: "运维助手",
  description: "部署巡检",
  systemPrompt: "你是运维专家",
  skills: ["superpowers:brainstorming"],
  tools: { mode: "whitelist" as const, whitelist: ["Bash", "Read"] },
  mcpServers: [
    { name: "fs", type: "http" as const, url: "https://x/mcp", headers: { k: "v" } },
    { name: "sh", type: "stdio" as const, command: "npx", args: ["s"], env: { T: "1" } },
  ],
  llm: { presetId: "0" },
  createdAt: "t",
  updatedAt: "t",
};

describe("Agent schema", () => {
  it("合法 agent 通过校验", () => {
    expect(() => AgentSchema.parse(valid)).not.toThrow();
  });
  it("tools.mode 只允许 all|whitelist", () => {
    expect(() => AgentSchema.parse({ ...valid, tools: { mode: "evil", whitelist: [] } })).toThrow();
  });
  it("缺少 ownerId 报错", () => {
    const { ownerId: _drop, ...rest } = valid;
    void _drop;
    expect(() => AgentSchema.parse(rest)).toThrow();
  });
  it("mcpServers.type 只允许 stdio|http", () => {
    expect(() =>
      AgentSchema.parse({ ...valid, mcpServers: [{ name: "x", type: "ftp" }] }),
    ).toThrow();
  });
  it("parseAgent 返回带默认值的对象", () => {
    const a = parseAgent(valid);
    expect(a.skills).toEqual(["superpowers:brainstorming"]);
    expect(a.mcpServers[0]?.headers).toEqual({ k: "v" });
    expect(a.gitRepositories).toEqual([]);
  });
});
