import { describe, expect, it } from "vitest";
import {
  type Agent,
  AgentSchema,
  agentToolCoverageWarnings,
  appendDefaultSkill,
  effectiveConversationScope,
  effectiveFeedbackScope,
  filterConversationsByScope,
  filterFeedbacksByScope,
  normalizeAgentCredentialRefs,
  parseAgent,
  resolveDuplicateName,
} from "../../src/domain/agent.js";
import type { Conversation } from "../../src/domain/conversation.js";

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
    expect(a.extensionDirectories).toEqual([]);
  });

  it("追加默认 Skill slash 指令", () => {
    expect(appendDefaultSkill("查询订单", "aliyun:sls-query")).toBe("查询订单\n/aliyun:sls-query");
    expect(appendDefaultSkill("查询订单")).toBe("查询订单");
  });
});

describe("场景与凭证归一化", () => {
  it("scenario 合法值通过、非法值报错", () => {
    expect(() => AgentSchema.parse({ ...valid, scenario: "code-dev" })).not.toThrow();
    expect(() => AgentSchema.parse({ ...valid, scenario: "代码开发" })).toThrow();
  });

  it("credentialCode 自动并入 credentials 并去重", () => {
    const repo = {
      id: "r1",
      name: "aix-py",
      provider: "jihulab" as const,
      url: "https://jihulab.com/your-org/your-project.git",
      required: true,
      shallow: true,
      syncMode: "fastForward" as const,
      credentialCode: "jihulab-pat",
    };
    const agent = parseAgent({
      ...valid,
      credentials: ["jihulab-pat", "sls-ak"],
      gitRepositories: [repo],
    });
    expect(normalizeAgentCredentialRefs(agent).credentials).toEqual(["jihulab-pat", "sls-ak"]);
  });

  it("无 credentialCode 时原样返回（引用相等）", () => {
    const agent = parseAgent({ ...valid, credentials: ["sls-ak"] });
    expect(normalizeAgentCredentialRefs(agent)).toBe(agent);
  });
});

describe("conversationScope 会话资源范围", () => {
  it("缺省字段 = 功能未开启，存量数据零迁移", () => {
    const a = parseAgent(valid);
    expect(a.conversationScope).toBeUndefined();
    expect(effectiveConversationScope(a, a.id)).toBeUndefined();
  });

  it("enabled=false 或缺省时 effectiveConversationScope 返回 undefined", () => {
    const a = parseAgent({ ...valid, conversationScope: { enabled: false, agentIds: ["x"] } });
    expect(effectiveConversationScope(a, a.id)).toBeUndefined();
  });

  it("开启后空 agentIds 默认仅本智能体，limit 缺省 10", () => {
    const a = parseAgent({ ...valid, conversationScope: { enabled: true, agentIds: [] } });
    const scope = effectiveConversationScope(a, "a1");
    expect(scope).toEqual({ agentIds: ["a1"], limit: 10 });
  });

  it("开启后沿用配置的 agentIds/days/limit", () => {
    const a = parseAgent({
      ...valid,
      conversationScope: { enabled: true, agentIds: ["a2", "a3"], days: 7, limit: 30 },
    });
    expect(effectiveConversationScope(a, "a1")).toEqual({
      agentIds: ["a2", "a3"],
      days: 7,
      limit: 30,
    });
  });

  it("days/limit 超界（>99）保存即拒绝", () => {
    expect(() =>
      AgentSchema.parse({
        ...valid,
        conversationScope: { enabled: true, agentIds: [], days: 100 },
      }),
    ).toThrow();
    expect(() =>
      AgentSchema.parse({ ...valid, conversationScope: { enabled: true, agentIds: [], limit: 0 } }),
    ).toThrow();
  });
});

describe("filterConversationsByScope", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const scopeOf = (agent: Agent) => effectiveConversationScope(agent, agent.id) ?? undefined;

  const makeConv = (over: Partial<Conversation>): Conversation => ({
    id: "c1",
    userId: "u1",
    sdkSessionId: "",
    title: "会话",
    channelId: "web",
    agentId: "a1",
    createdAt: day(1),
    updatedAt: day(1),
    archived: false,
    ...over,
  });

  const agent = parseAgent({
    ...valid,
    conversationScope: { enabled: true, agentIds: ["a1", "a2"], days: 7, limit: 3 },
  });

  it("按属主过滤：他人的会话一律不可见（跨用户铁律）", () => {
    const scope = scopeOf(agent);
    expect(scope).toBeDefined();
    if (!scope) return;
    const out = filterConversationsByScope(
      [makeConv({ userId: "other", id: "c1" })],
      scope,
      "u1",
      now,
    );
    expect(out).toEqual([]);
  });

  it("按智能体范围过滤：绑定范围外智能体（含闲聊防御 agentId 空）不入集", () => {
    const scope = scopeOf(agent);
    expect(scope).toBeDefined();
    if (!scope) return;
    const out = filterConversationsByScope(
      [
        makeConv({ id: "c-in", agentId: "a2" }),
        makeConv({ id: "c-out", agentId: "a9" }),
        makeConv({ id: "c-chat", agentId: "" }),
      ],
      scope,
      "u1",
      now,
    );
    expect(out.map((c) => c.id)).toEqual(["c-in"]);
  });

  it("按时间窗口过滤：超 days 的会话不入集", () => {
    const scope = scopeOf(agent);
    expect(scope).toBeDefined();
    if (!scope) return;
    const out = filterConversationsByScope(
      [
        makeConv({ id: "c-fresh", updatedAt: day(1) }),
        makeConv({ id: "c-stale", updatedAt: day(8) }),
      ],
      scope,
      "u1",
      now,
    );
    expect(out.map((c) => c.id)).toEqual(["c-fresh"]);
  });

  it("updatedAt 降序 + limit 截断 + 排除当前会话", () => {
    const scope = scopeOf(agent);
    expect(scope).toBeDefined();
    if (!scope) return;
    const out = filterConversationsByScope(
      [
        makeConv({ id: "cur", updatedAt: day(0) }),
        makeConv({ id: "c1", updatedAt: day(1) }),
        makeConv({ id: "c2", updatedAt: day(2) }),
        makeConv({ id: "c3", updatedAt: day(3) }),
        makeConv({ id: "c4", updatedAt: day(4) }),
      ],
      scope,
      "u1",
      now,
      "cur",
    );
    expect(out.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });
});

describe("resolveDuplicateName（复制命名规则 §3.3）", () => {
  it("自己的智能体：无条件加 -副本 后缀", () => {
    expect(resolveDuplicateName("ai-audit", true, "任何人", new Set())).toBe("ai-audit-副本");
  });

  it("他人的智能体：无同名沿用原名；同名加分享人名", () => {
    expect(resolveDuplicateName("ai-audit", false, "用户1", new Set())).toBe("ai-audit");
    expect(resolveDuplicateName("ai-audit", false, "用户1", new Set(["ai-audit"]))).toBe(
      "ai-audit-用户1",
    );
  });

  it("二次撞名：追加序号 -2、-3", () => {
    expect(resolveDuplicateName("tool", true, "x", new Set(["tool", "tool-副本"]))).toBe(
      "tool-副本-2",
    );
    expect(resolveDuplicateName("tool", false, "用户1", new Set(["tool", "tool-用户1"]))).toBe(
      "tool-用户1-2",
    );
  });
});

describe("feedbackScope 反馈资源范围", () => {
  it("缺省字段 = 功能未开启，存量数据零迁移", () => {
    const a = parseAgent(valid);
    expect(a.feedbackScope).toBeUndefined();
    expect(effectiveFeedbackScope(a)).toBeUndefined();
  });

  it("enabled=false 时 effectiveFeedbackScope 返回 undefined；开启后 days 缺省不限、limit 缺省 10", () => {
    const off = parseAgent({ ...valid, feedbackScope: { enabled: false } });
    expect(effectiveFeedbackScope(off)).toBeUndefined();
    const on = parseAgent({ ...valid, feedbackScope: { enabled: true } });
    expect(effectiveFeedbackScope(on)).toEqual({ limit: 10 });
    const full = parseAgent({
      ...valid,
      feedbackScope: { enabled: true, days: 7, limit: 30 },
    });
    expect(effectiveFeedbackScope(full)).toEqual({ days: 7, limit: 30 });
  });

  it("days/limit 超界（>99）保存即拒绝", () => {
    expect(() =>
      AgentSchema.parse({ ...valid, feedbackScope: { enabled: true, days: 100 } }),
    ).toThrow();
    expect(() =>
      AgentSchema.parse({ ...valid, feedbackScope: { enabled: true, limit: 0 } }),
    ).toThrow();
  });
});

describe("filterFeedbacksByScope", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const fbScopeAgent = parseAgent({
    ...valid,
    feedbackScope: { enabled: true, days: 7, limit: 2 },
  });
  const scope = effectiveFeedbackScope(fbScopeAgent) ?? undefined;

  it("窗口外（updatedAt 早于 days）不入集；按 updatedAt 降序截 limit", () => {
    expect(scope).toBeDefined();
    if (!scope) return;
    const out = filterFeedbacksByScope(
      [
        { id: "in-new", updatedAt: day(0) },
        { id: "in-old", updatedAt: day(1) },
        { id: "out", updatedAt: day(10) },
        { id: "in-2", updatedAt: day(2) },
      ],
      scope,
      now,
    );
    expect(out.map((f) => f.id)).toEqual(["in-new", "in-old"]);
  });

  it("days 缺省 = 不限天", () => {
    const noDays = effectiveFeedbackScope(
      parseAgent({ ...valid, feedbackScope: { enabled: true, limit: 1 } }),
    );
    expect(noDays).toBeDefined();
    if (!noDays) return;
    const out = filterFeedbacksByScope(
      [
        { id: "ancient", updatedAt: "2020-01-01T00:00:00.000Z" },
        { id: "new", updatedAt: day(0) },
      ],
      noDays,
      now,
    );
    expect(out.map((f) => f.id)).toEqual(["new"]);
  });
});

describe("agentToolCoverageWarnings（白名单完备性静态校验）", () => {
  const agentWith = (skills: string[], tools: Agent["tools"]): Pick<Agent, "skills" | "tools"> => ({
    skills,
    tools,
  });

  it("all 模式与未勾选技能不告警", () => {
    expect(
      agentToolCoverageWarnings(agentWith(["code-review-execute"], { mode: "all", whitelist: [] })),
    ).toEqual([]);
    expect(
      agentToolCoverageWarnings(agentWith([], { mode: "whitelist", whitelist: ["Bash"] })),
    ).toEqual([]);
  });

  it("白名单为空 + 有技能：提示技能操作将全部被拒", () => {
    const out = agentToolCoverageWarnings(
      agentWith(["code-review-execute"], { mode: "whitelist", whitelist: [] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("白名单为空");
  });

  it("缺核心工具逐项点名（analyzer 缺 Write 卡死任务的配置性误伤面）", () => {
    const out = agentToolCoverageWarnings(
      agentWith(["code-review-execute"], { mode: "whitelist", whitelist: ["Bash", "Read"] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Write");
    expect(out[0]).toContain("Edit");
    expect(out[0]).not.toContain("Bash（");
    expect(out[0]).not.toContain("Read（");
  });

  it("白名单齐备不告警", () => {
    expect(
      agentToolCoverageWarnings(
        agentWith(["code-review-execute"], {
          mode: "whitelist",
          whitelist: ["Write", "Edit", "Read", "Bash", "mcp__donger-git"],
        }),
      ),
    ).toEqual([]);
  });
});
