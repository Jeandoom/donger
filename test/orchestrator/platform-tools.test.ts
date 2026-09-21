import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { Agent, AgentInput } from "../../src/domain/agent.js";
import type { Conversation } from "../../src/domain/conversation.js";
import type { SkillPack } from "../../src/domain/skill-pack.js";
import type { User } from "../../src/domain/user.js";
import { platformToolDefinitions } from "../../src/orchestrator/platform-tools.js";
import type { AgentStore } from "../../src/ports/agent-store.js";
import type { ConversationStore } from "../../src/ports/conversation-store.js";
import type { SkillInstaller } from "../../src/ports/skill-installer.js";
import type { SkillPackStore } from "../../src/ports/skill-pack-store.js";

const USER: User = {
  id: "u-1",
  name: "tester",
  role: "user",
  homeDir: tmpdir(),
  createdAt: "t",
  updatedAt: "t",
};

/** 内存 AgentStore：覆盖测试用到的 7 个方法 */
function mockAgentStore(): AgentStore & { rows: Map<string, Agent> } {
  const rows = new Map<string, Agent>();
  const store = {
    rows,
    async create(input: AgentInput) {
      const a = {
        credentials: [],
        gitRepositories: [],
        extensionDirectories: [],
        version: 1,
        ...input,
        id: `id-${rows.size + 1}`,
        createdAt: "t",
        updatedAt: "t",
      } as Agent;
      rows.set(a.id, a);
      return a;
    },
    async get(id: string) {
      return rows.get(id);
    },
    async listByOwner(ownerId: string) {
      return [...rows.values()].filter((a) => a.ownerId === ownerId);
    },
    async listSharedWith() {
      return [];
    },
    async listAll() {
      return [...rows.values()];
    },
    async update(id: string, patch: Partial<Agent>) {
      const cur = rows.get(id);
      if (!cur) throw new Error(`agent 不存在: ${id}`);
      const next = { ...cur, ...patch, id };
      rows.set(id, next);
      return next;
    },
    async delete(id: string) {
      rows.delete(id);
    },
  };
  return store as unknown as AgentStore & { rows: Map<string, Agent> };
}

const INSTALLER: SkillInstaller = {
  installFromGit: async () => {
    throw new Error("不支持");
  },
  installFromUpload: async () => {
    throw new Error("不支持");
  },
  installFromPaste: async (_userId, req): Promise<SkillPack> => ({
    id: "p1",
    userId: _userId,
    slug: req.slug ?? "s",
    name: req.slug ?? "s",
    description: req.description ?? "",
    version: "0.1.0",
    source: { kind: "paste" },
    installedPath: ".skills/s",
    enabled: true,
    builtin: false,
    credentials: [],
    createdAt: "t",
    updatedAt: "t",
  }),
  installBuiltin: async () => {
    throw new Error("不支持");
  },
  uninstall: async () => {},
  update: async () => {
    throw new Error("不支持");
  },
  readSkillDoc: async (_userId, _packId, skillName) => `# mock ${skillName}`,
  updateSkillDoc: async (_userId, _packId, skillName, content) => {
    recorded.updateSkillCalls.push({ skillName, content });
    return {
      id: "p1",
      userId: _userId,
      slug: "s",
      name: skillName,
      description: "",
      version: "0.1.0",
      source: { kind: "paste" },
      installedPath: ".skills/s",
      enabled: true,
      builtin: false,
      credentials: [],
      createdAt: "t",
      updatedAt: "t",
    };
  },
};

/** update_skill 调用记录（测试内断言透传） */
const recorded: { updateSkillCalls: Array<{ skillName: string; content: string }> } = {
  updateSkillCalls: [],
};

const PACK_STORE: SkillPackStore = {
  async listPacks() {
    return [];
  },
  async getPack() {
    return undefined;
  },
  async getPackBySlug() {
    return undefined;
  },
  async upsertPack() {},
  async deletePack() {},
  async listSkills() {
    return [];
  },
  async upsertSkills() {},
  async setPackEnabled() {},
  async setSkillEnabled() {},
  async listEnabledSkillsWithPack(userId) {
    return [
      {
        skill: {
          id: "s1",
          userId,
          packId: "p1",
          name: "gitlab-execute",
          description: "GitLab 执行",
          relativePath: "skills/x",
          enabled: true,
          createdAt: "t",
          updatedAt: "t",
        },
        pack: {
          id: "p1",
          userId,
          slug: "gitlab",
          name: "gitlab",
          description: "",
          source: { kind: "builtin" },
          installedPath: "",
          enabled: true,
          builtin: false,
          credentials: [],
          createdAt: "t",
          updatedAt: "t",
        },
      },
    ];
  },
};

const CONNECTOR_STORE = {
  async listForUser(_userId: string) {
    return [
      {
        id: "c1",
        name: "crm-api",
        description: "CRM 查询",
        transport: "http" as const,
        url: "https://crm.example.com/mcp",
        headers: { Authorization: "{{credential:CRM}}" },
        enabled: true,
        shareScope: "global" as const,
        ownerId: "someone-else",
        createdAt: "t",
        updatedAt: "t",
      },
    ];
  },
};

type Deps = Parameters<typeof platformToolDefinitions>[0];

function findTool(deps: Deps, name: string) {
  const t = platformToolDefinitions(deps).find((d) => d.name === name);
  if (!t) throw new Error(`tool 不存在: ${name}`);
  return t;
}

const baseDeps = (agentStore: ReturnType<typeof mockAgentStore>): Deps => ({
  user: USER,
  agentStore,
  installer: INSTALLER,
  packStore: PACK_STORE,
});

/** 内存会话存储：可变 agentId，供 finish_builder 断言解绑效果 */
function mockConvStore(agentId: string): ConversationStore & { conv: Conversation } {
  const conv: Conversation = {
    id: "conv-1",
    userId: USER.id,
    sdkSessionId: "",
    title: "t",
    channelId: "cli",
    agentId,
    createdAt: "t",
    updatedAt: "t",
    archived: false,
  };
  return {
    conv,
    async create() {
      return conv;
    },
    async createWithAgent() {
      return conv;
    },
    async get() {
      return conv;
    },
    async getLatest() {
      return conv;
    },
    async listByUser() {
      return [conv];
    },
    async update(_id, patch) {
      Object.assign(conv, patch);
    },
  };
}

describe("平台工具", () => {
  it("list_agents / list_skills 返回 JSON 摘要", async () => {
    const store = mockAgentStore();
    await store.create({
      ownerId: USER.id,
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
    });
    const deps = baseDeps(store);
    const agents = await findTool(deps, "list_agents").handler({});
    expect(agents.isError).toBeUndefined();
    expect(agents.content[0]?.text).toContain('"name": "A"');
    const skills = await findTool(deps, "list_skills").handler({});
    expect(skills.content[0]?.text).toContain("gitlab-execute");
  });

  it("create_agent：创建归属当前用户；重名报错", async () => {
    const store = mockAgentStore();
    const deps = baseDeps(store);
    const r = await findTool(deps, "create_agent").handler({ name: "A", systemPrompt: "x" });
    expect(r.content[0]?.text).toContain("已创建智能体");
    expect(store.rows.values().next().value?.ownerId).toBe(USER.id);
    const dup = await findTool(deps, "create_agent").handler({ name: "A" });
    expect(dup.isError).toBe(true);
    expect(dup.content[0]?.text).toContain("同名智能体已存在");
  });

  it("create_agent：引用不存在/未启用的技能名报错并提示核对", async () => {
    const store = mockAgentStore();
    const deps = baseDeps(store);
    const r = await findTool(deps, "create_agent").handler({
      name: "A",
      skills: ["nope-execute"],
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("nope-execute");
    expect(r.content[0]?.text).toContain("list_skills");
    expect(store.rows.size).toBe(0);
    const ok = await findTool(deps, "create_agent").handler({
      name: "B",
      skills: ["gitlab-execute"],
    });
    expect(ok.isError).toBeUndefined();
    expect(store.rows.size).toBe(1);
  });

  it("update_agent：owner 可改；非 owner 报错", async () => {
    const store = mockAgentStore();
    const deps = baseDeps(store);
    const created = await store.create({
      ownerId: USER.id,
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
    });
    const ok = await findTool(deps, "update_agent").handler({
      agentId: created.id,
      description: "new",
    });
    expect(ok.isError).toBeUndefined();
    const otherDeps: Deps = { ...deps, user: { ...USER, id: "u-other" } };
    const denied = await findTool(otherDeps, "update_agent").handler({
      agentId: created.id,
      description: "x",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain("无权修改");
  });

  it("write_skill：走 installFromPaste（透传 name/description/slug）", async () => {
    const store = mockAgentStore();
    const calls: Array<{ userId: string; req: unknown }> = [];
    const installer: SkillInstaller = {
      ...INSTALLER,
      installFromPaste: async (userId, req) => {
        calls.push({ userId, req });
        return INSTALLER.installFromPaste(userId, req);
      },
    };
    const deps: Deps = { ...baseDeps(store), installer };
    const r = await findTool(deps, "write_skill").handler({
      name: "x-execute",
      description: "d",
      content: "---\nname: x-execute\n---\n正文",
    });
    expect(r.isError).toBeUndefined();
    expect(calls[0]?.userId).toBe(USER.id);
    expect(calls[0]?.req).toMatchObject({ name: "x-execute", description: "d" });
  });

  it("create_agent：tools 参数落库并回显；缺省 all", async () => {
    const store = mockAgentStore();
    const deps = baseDeps(store);
    const r = await findTool(deps, "create_agent").handler({
      name: "RO",
      tools: { mode: "whitelist", whitelist: ["Read", "Glob", "Grep"] },
    });
    expect(r.content[0]?.text).toContain("工具白名单：Read、Glob、Grep");
    const all = await findTool(deps, "create_agent").handler({ name: "ALL" });
    expect(all.content[0]?.text).toContain("工具全开");
  });

  it("finish_builder：解绑 builder 会话；未绑定时拒绝", async () => {
    const store = mockAgentStore();
    const bound = mockConvStore("agent-builder");
    const boundDeps: Deps = {
      ...baseDeps(store),
      conversationStore: bound,
      conversationId: bound.conv.id,
    };
    const ok = await findTool(boundDeps, "finish_builder").handler({});
    expect(ok.isError).toBeUndefined();
    expect(bound.conv.agentId).toBe("");
    const unbound = mockConvStore("");
    const unboundDeps: Deps = {
      ...baseDeps(store),
      conversationStore: unbound,
      conversationId: unbound.conv.id,
    };
    const refuse = await findTool(unboundDeps, "finish_builder").handler({});
    expect(refuse.isError).toBe(true);
    expect(refuse.content[0]?.text).toContain("未绑定");
  });

  it("create_agent：gitRepositories 的 credentialCode 归一化并入 credentials，缺值给装备提示", async () => {
    const store = mockAgentStore();
    const credentialSets = {
      getFilledValues: async (_uid: string, codes: string[]) =>
        codes
          .filter((c) => c !== "jihulab-pat")
          .map((code) => ({
            userId: _uid,
            code,
            values: { token: "x" },
            createdAt: "t",
            updatedAt: "t",
          })),
    };
    const deps: Deps = { ...baseDeps(store), credentialSets: credentialSets as never };
    const r = await findTool(deps, "create_agent").handler({
      name: "aix",
      scenario: "code-dev",
      credentials: ["jihulab-pat"],
      gitRepositories: [
        {
          id: "r1",
          name: "aix-py",
          provider: "jihulab",
          url: "https://jihulab.com/your-org/your-project.git",
          required: true,
          shallow: true,
          syncMode: "fastForward",
          credentialCode: "jihulab-pat",
        },
      ],
    });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toContain("装备提示");
    expect(r.content[0]?.text).toContain("jihulab-pat");
    const saved = [...store.rows.values()][0];
    expect(saved?.credentials).toEqual(["jihulab-pat"]);
    expect(saved?.gitRepositories[0]?.name).toBe("aix-py");
  });

  it("create_agent：scenario=code-dev 且无仓库给出 preset 警示", async () => {
    const store = mockAgentStore();
    const deps = baseDeps(store);
    const r = await findTool(deps, "create_agent").handler({ name: "dev", scenario: "code-dev" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toContain("至少绑定一个 git 仓库");
  });

  it("read_skill：按 slug 找 pack 后透传 readSkillDoc；pack 不存在报错", async () => {
    const store = mockAgentStore();
    const packStore = {
      ...PACK_STORE,
      async getPackBySlug(_uid: string, slug: string) {
        return slug === "s"
          ? ({
              id: "p1",
              userId: USER.id,
              slug: "s",
              name: "s",
              description: "",
              source: { kind: "paste" },
              installedPath: ".skills/s",
              enabled: true,
              builtin: false,
              createdAt: "t",
              updatedAt: "t",
            } as SkillPack)
          : undefined;
      },
    } as SkillPackStore;
    const okR = await findTool({ ...baseDeps(store), packStore }, "read_skill").handler({
      pack: "s",
      name: "hello",
    });
    expect(okR.isError).toBeUndefined();
    expect(okR.content[0]?.text).toBe("# mock hello");
    const bad = await findTool({ ...baseDeps(store), packStore }, "read_skill").handler({
      pack: "nope",
      name: "hello",
    });
    expect(bad.isError).toBe(true);
  });

  it("update_skill：pack 不存在时不落盘", async () => {
    recorded.updateSkillCalls.length = 0;
    const store = mockAgentStore();
    const r = await findTool(baseDeps(store), "update_skill").handler({
      pack: "missing",
      name: "x",
      content: `---
name: x
description: d
---
`,
    });
    expect(r.isError).toBe(true);
    expect(recorded.updateSkillCalls).toHaveLength(0);
  });

  it("list_connectors：仅安全字段（不含 headers 凭证）；未装配时提示不可用", async () => {
    const withConn = await findTool(
      { ...baseDeps(mockAgentStore()), connectorStore: CONNECTOR_STORE as never },
      "list_connectors",
    ).handler({});
    expect(withConn.isError).toBeUndefined();
    const text = withConn.content[0]?.text ?? "";
    expect(text).toContain("crm-api");
    expect(text).toContain("https://crm.example.com/mcp");
    expect(text).not.toContain("{{credential:CRM}}");
    expect(text).not.toContain("Authorization");
    const without = await findTool(baseDeps(mockAgentStore()), "list_connectors").handler({});
    expect(without.isError).toBe(true);
    expect(without.content[0]?.text).toContain("未装配");
  });
});
