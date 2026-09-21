import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/domain/agent.js";
import { renderAgentRegistry } from "../../src/domain/dispatcher-registry.js";

/** 最小可用 agent 构造（字段可覆盖） */
function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "a2bf3c71-0000",
    ownerId: "u-1",
    name: "jihulab",
    description: "GitLab 仓库查询与操作",
    skills: [],
    tools: { mode: "all", whitelist: [] },
    mcpServers: [],
    credentials: [],
    gitRepositories: [],
    extensionDirectories: [],
    version: 1,
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  };
}

describe("renderAgentRegistry", () => {
  it("渲染表头 + 每行一个 agent，列取值来自实体", () => {
    const out = renderAgentRegistry([
      makeAgent({
        skills: ["gitlab-design", "gitlab-execute"],
        extensionDirectories: [{ id: "kb1", name: "业务知识库", path: "/kb", access: "readOnly" }],
      }),
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toContain("| agentId | 名称 | 职责 | skills | 适用任务类型 | 业务知识库 |");
    expect(out).toContain(
      "| a2bf3c71-0000 | jihulab | GitLab 仓库查询与操作 | gitlab-design / gitlab-execute |",
    );
    expect(out).toContain("| 业务知识库 |");
  });

  it("scenario 受控词表：登记「场景名（key）」", () => {
    const out = renderAgentRegistry([makeAgent({ scenario: "kb-qa" })]);
    expect(out).toContain("知识库问答（kb-qa）");
  });

  it("未标 scenario：按名称+描述 best-effort 推断场景 key", () => {
    const out = renderAgentRegistry([makeAgent({ description: "克隆并分析代码仓库结构" })]);
    expect(out).toContain("code-dev");
  });

  it("未标 scenario 且无关键词：标「未标注」", () => {
    const out = renderAgentRegistry([makeAgent({ name: "weather", description: "天气查询" })]);
    expect(out).toContain("未标注");
  });

  it("空 skills / 空描述 / 空知识库给占位，不留空单元格", () => {
    const out = renderAgentRegistry([makeAgent({ description: undefined, skills: [] })]);
    expect(out).toContain("（未填写）");
    expect(out).toContain("| 无 | 未标注 | 无 |");
  });

  it("单元格消毒：竖线/换行不破坏表格行结构", () => {
    const out = renderAgentRegistry([
      makeAgent({ id: "a3", description: "巡检 | 部署\n含换行", name: "a|b" }),
    ]);
    const rowLine = out.split("\n").find((l) => l.startsWith("| a3 |"));
    expect(rowLine).toBeDefined();
    // 行内竖线数量固定为 7（6 列表格），消毒后不新增分隔符
    expect((rowLine ?? "").match(/\|/g)).toHaveLength(7);
    expect(rowLine).toContain("巡检 ／ 部署 含换行");
    expect(rowLine).toContain("a／b");
  });

  it("空集合：仅表头（由调用方补充空表提示）", () => {
    const out = renderAgentRegistry([]);
    expect(out.split("\n")).toHaveLength(2);
  });
});
