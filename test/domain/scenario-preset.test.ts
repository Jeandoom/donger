import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/domain/agent.js";
import {
  isScenarioKey,
  KB_READ_TOOLS,
  migrateTaskTypes,
  parseTaskTypes,
  SCENARIO_KEYS,
  validateAgentAgainstPreset,
} from "../../src/domain/scenario-preset.js";

function baseAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "a1",
    ownerId: "u1",
    name: "测试智能体",
    skills: [],
    tools: { mode: "whitelist", whitelist: ["Read"] },
    mcpServers: [],
    credentials: [],
    gitRepositories: [],
    extensionDirectories: [],
    version: 1,
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  } as Agent;
}

const repo = {
  id: "r1",
  name: "aix-py",
  provider: "jihulab" as const,
  url: "https://jihulab.com/your-org/your-project.git",
  required: true,
  shallow: true,
  syncMode: "fastForward" as const,
};

describe("场景词表", () => {
  it("isScenarioKey 合法与非法值", () => {
    for (const key of SCENARIO_KEYS) expect(isScenarioKey(key)).toBe(true);
    expect(isScenarioKey("代码开发")).toBe(false);
    expect(isScenarioKey("")).toBe(false);
  });

  describe("parseTaskTypes", () => {
    it("多分隔符与去重", () => {
      expect(parseTaskTypes("code-dev、kb-qa, code-dev")).toEqual({
        ok: true,
        keys: ["code-dev", "kb-qa"],
      });
    });
    it("非法值全部列出", () => {
      const result = parseTaskTypes("代码开发, kb-qa, 未知");
      expect(result).toEqual({ ok: false, invalid: ["代码开发", "未知"] });
    });
  });

  describe("migrateTaskTypes", () => {
    it.each([
      ["代码分析、git 仓库审查", ["code-dev", "research"]],
      ["知识库文档问答", ["kb-qa"]],
      ["部署与日志监控", ["ops"]],
      ["调研报告撰写", ["research"]],
      ["完全无关文本", []],
    ])("%s → %j", (text, expected) => {
      expect(migrateTaskTypes(text)).toEqual(expected);
    });
  });
});

describe("validateAgentAgainstPreset", () => {
  it("未标 scenario 不校验", () => {
    expect(validateAgentAgainstPreset(baseAgent())).toEqual([]);
  });

  describe("code-dev", () => {
    it("无仓库报警", () => {
      const warnings = validateAgentAgainstPreset(baseAgent({ scenario: "code-dev" }));
      expect(warnings.map((w) => w.rule)).toContain("git-repos");
    });
    it("仓库缺 credentialCode 逐仓提示", () => {
      const warnings = validateAgentAgainstPreset(
        baseAgent({ scenario: "code-dev", gitRepositories: [repo] as Agent["gitRepositories"] }),
      );
      expect(warnings.filter((w) => w.rule === "credential-code")).toHaveLength(1);
    });
    it("齐全且 whitelist 无警", () => {
      const warnings = validateAgentAgainstPreset(
        baseAgent({
          scenario: "code-dev",
          tools: { mode: "whitelist", whitelist: ["mcp__donger-git", "Read"] },
          gitRepositories: [
            { ...repo, credentialCode: "jihulab-pat" } as Agent["gitRepositories"][number],
          ],
        }),
      );
      expect(warnings).toEqual([]);
    });
    it("mode=all 提示收敛", () => {
      const warnings = validateAgentAgainstPreset(
        baseAgent({
          scenario: "code-dev",
          tools: { mode: "all", whitelist: [] },
          gitRepositories: [
            { ...repo, credentialCode: "jihulab-pat" } as Agent["gitRepositories"][number],
          ],
        }),
      );
      expect(warnings.map((w) => w.rule)).toContain("tools-whitelist");
    });
  });

  describe("kb-qa", () => {
    it("只读三件齐全无警", () => {
      const warnings = validateAgentAgainstPreset(
        baseAgent({
          scenario: "kb-qa",
          tools: { mode: "whitelist", whitelist: [...KB_READ_TOOLS] },
        }),
      );
      expect(warnings).toEqual([]);
    });
    it("白名单含 Bash 报只读违规", () => {
      const warnings = validateAgentAgainstPreset(
        baseAgent({
          scenario: "kb-qa",
          tools: { mode: "whitelist", whitelist: [...KB_READ_TOOLS, "Bash"] },
        }),
      );
      expect(warnings.map((w) => w.rule)).toContain("read-only");
    });
    it("缺检索工具报警", () => {
      const warnings = validateAgentAgainstPreset(
        baseAgent({ scenario: "kb-qa", tools: { mode: "whitelist", whitelist: ["Read"] } }),
      );
      expect(warnings.filter((w) => w.rule === "kb-tools")).toHaveLength(3);
    });
    it("mode=all 报安全违规", () => {
      const warnings = validateAgentAgainstPreset(
        baseAgent({ scenario: "kb-qa", tools: { mode: "all", whitelist: [] } }),
      );
      expect(warnings.map((w) => w.rule)).toContain("tools-whitelist");
    });
  });

  describe("research", () => {
    it("缺 kb_write 报警", () => {
      const warnings = validateAgentAgainstPreset(
        baseAgent({
          scenario: "research",
          tools: { mode: "whitelist", whitelist: [...KB_READ_TOOLS] },
        }),
      );
      expect(warnings.map((w) => w.rule)).toContain("kb-write");
    });
    it("含 kb_write 无警", () => {
      const warnings = validateAgentAgainstPreset(
        baseAgent({
          scenario: "research",
          tools: { mode: "whitelist", whitelist: [...KB_READ_TOOLS, "mcp__donger-kb__kb_write"] },
        }),
      );
      expect(warnings).toEqual([]);
    });
  });

  it("ops：mode=all 提示收敛", () => {
    const warnings = validateAgentAgainstPreset(
      baseAgent({ scenario: "ops", tools: { mode: "all", whitelist: [] } }),
    );
    expect(warnings.map((w) => w.rule)).toContain("tools-whitelist");
  });
});
