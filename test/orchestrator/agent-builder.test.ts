import { describe, expect, it } from "vitest";
import {
  AGENT_BUILDER_AGENT,
  AGENT_BUILDER_ID,
  builderCreationAsk,
} from "../../src/orchestrator/agent-builder.js";

describe("agent-builder 内置智能体", () => {
  it("id 匹配路由约束（\\w-）且平台工具白名单", () => {
    expect(AGENT_BUILDER_ID).toMatch(/^[\w-]+$/);
    expect(AGENT_BUILDER_AGENT.id).toBe(AGENT_BUILDER_ID);
    expect(AGENT_BUILDER_AGENT.tools).toEqual({
      mode: "whitelist",
      whitelist: ["mcp__donger-platform", "AskUserQuestion"],
    });
  });

  it("白名单含 AskUserQuestion（工作流第 1 步提问依赖，复盘 P1-4）", () => {
    expect(AGENT_BUILDER_AGENT.tools.whitelist).toContain("AskUserQuestion");
  });

  it("builderCreationAsk 拼接缺口分析与原始任务", () => {
    const p = builderCreationAsk("帮我每天巡检 SLS 错误日志", "缺少运维巡检类智能体");
    expect(p).toContain("缺少运维巡检类智能体");
    expect(p).toContain("帮我每天巡检 SLS 错误日志");
    expect(p).toContain("沉淀为智能体");
  });

  it("系统提示要求登记后调用 finish_builder 解绑会话", () => {
    expect(AGENT_BUILDER_AGENT.systemPrompt).toContain("finish_builder");
  });
});
