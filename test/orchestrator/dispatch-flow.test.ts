import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/domain/agent.js";
import {
  buildDispatcherAgent,
  dispatcherSystemPrompt,
} from "../../src/orchestrator/dispatch-flow.js";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "a2bf3c71-0000",
    ownerId: "u-1",
    name: "jihulab",
    description: "GitLab 仓库查询与操作",
    skills: ["gitlab-execute"],
    tools: { mode: "all", whitelist: [] },
    mcpServers: [],
    credentials: [],
    gitRepositories: [],
    extensionDirectories: [],
    llm: {},
    version: 1,
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  };
}

describe("dispatcherSystemPrompt", () => {
  it("登记表/场景词表/路由规则/输出契约全部内联", () => {
    const prompt = dispatcherSystemPrompt([makeAgent()]);
    expect(prompt).toContain("a2bf3c71-0000");
    expect(prompt).toContain("jihulab");
    expect(prompt).toContain("## 场景词表");
    expect(prompt).toContain("code-dev（代码项目开发运维）");
    expect(prompt).toContain("kb-qa（知识库问答）");
    expect(prompt).toContain("## 路由规则");
    expect(prompt).toContain('"agentId"');
    expect(prompt).toContain("taskType 填 chat");
    // 不再引导读文件
    expect(prompt).not.toContain("Read 工具读取");
    expect(prompt).not.toContain("agents.md");
  });

  it("空集合：给出「暂无可用智能体，路由 none」提示", () => {
    const prompt = dispatcherSystemPrompt([]);
    expect(prompt).toContain("当前暂无可用智能体");
    expect(prompt).toContain("都填 none");
  });
});

describe("buildDispatcherAgent", () => {
  it("内置 dispatcher：可见 agent 集合进系统提示，无扩展目录挂载，工具只读兜底", () => {
    const agent = buildDispatcherAgent([makeAgent()]);
    expect(agent.id).toBe("builtin-dispatcher");
    expect(agent.skills).toEqual(["task-dispatch"]);
    expect(agent.systemPrompt).toContain("a2bf3c71-0000");
    expect(agent.extensionDirectories).toHaveLength(0);
    expect(agent.tools).toEqual({ mode: "whitelist", whitelist: ["Read"] });
  });
});

// 注：dispatchTask 已退役，dispatcher 轮走 Orchestrator.runDispatcherTurn（统一 turn 管道）。
// 编排行为（路由命中/noResume/DISPATCH_FAILED 转译/可见性过滤）由 test/orchestrator/orchestrator-phases.test.ts
// 与 orchestrator-queue.test.ts 在 handleMessage 层覆盖。
