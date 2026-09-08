import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Agent, AgentInput } from "../../src/domain/agent.js";
import type { Conversation } from "../../src/domain/conversation.js";
import type { SkillPack } from "../../src/domain/skill-pack.js";
import type { User } from "../../src/domain/user.js";
import { ensureDispatcherKb } from "../../src/orchestrator/dispatch-kb.js";
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

/** 内存 AgentStore：覆盖测试用到的 6 个方法 */
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

const KB_DIR = mkdtempSync(join(tmpdir(), "donger-kb-"));
ensureDispatcherKb(KB_DIR);

/** 每个登记用例独立 KB 目录（避免同文件内共享 agents.md 互相撞「已登记」） */
function freshKbDir(): string {
  const d = mkdtempSync(join(tmpdir(), "donger-kb2-"));
  ensureDispatcherKb(d);
  return d;
}

type Deps = Parameters<typeof platformToolDefinitions>[0];

function findTool(deps: Deps, name: string) {
  const t = platformToolDefinitions(deps).find((d) => d.name === name);
  if (!t) throw new Error(`tool 不存在: ${name}`);
  return t;
}

const baseDeps = (agentStore: ReturnType<typeof mockAgentStore>, kbDir?: string): Deps => ({
  user: USER,
  agentStore,
  installer: INSTALLER,
  packStore: PACK_STORE,
  ...(kbDir ? { kbDir } : {}),
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
      llm: {},
    });
    const deps = baseDeps(store, KB_DIR);
    const agents = await findTool(deps, "list_agents").handler({});
    expect(agents.isError).toBeUndefined();
    expect(agents.content[0]?.text).toContain('"name": "A"');
    const skills = await findTool(deps, "list_skills").handler({});
    expect(skills.content[0]?.text).toContain("gitlab-execute");
  });

  it("create_agent：创建归属当前用户；重名报错", async () => {
    const store = mockAgentStore();
    const deps = baseDeps(store, KB_DIR);
    const r = await findTool(deps, "create_agent").handler({ name: "A", systemPrompt: "x" });
    expect(r.content[0]?.text).toContain("已创建智能体");
    expect(store.rows.values().next().value?.ownerId).toBe(USER.id);
    const dup = await findTool(deps, "create_agent").handler({ name: "A" });
    expect(dup.isError).toBe(true);
    expect(dup.content[0]?.text).toContain("同名智能体已存在");
  });

  it("create_agent：引用不存在/未启用的技能名报错并提示核对", async () => {
    const store = mockAgentStore();
    const deps = baseDeps(store, KB_DIR);
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
    const deps = baseDeps(store, KB_DIR);
    const created = await store.create({
      ownerId: USER.id,
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
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
    const deps: Deps = { ...baseDeps(store, KB_DIR), installer };
    const r = await findTool(deps, "write_skill").handler({
      name: "x-execute",
      description: "d",
      content: "---\nname: x-execute\n---\n正文",
    });
    expect(r.isError).toBeUndefined();
    expect(calls[0]?.userId).toBe(USER.id);
    expect(calls[0]?.req).toMatchObject({ name: "x-execute", description: "d" });
  });

  it("update_kb_registry：追加行落盘且重复调用报错", async () => {
    const store = mockAgentStore();
    const created = await store.create({
      ownerId: USER.id,
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
    });
    const deps = baseDeps(store, KB_DIR);
    const args = {
      agentId: created.id,
      name: "A",
      duty: "测试",
      skills: ["a-execute"],
      taskTypes: "code-dev",
    };
    const r = await findTool(deps, "update_kb_registry").handler(args);
    expect(r.isError).toBeUndefined();
    const md = readFileSync(join(KB_DIR, "dispatcher", "agents.md"), "utf8");
    expect(md).toContain(`| ${created.id} | A | 测试 | a-execute | code-dev | 无 |`);
    const dup = await findTool(deps, "update_kb_registry").handler(args);
    expect(dup.isError).toBe(true);
  });

  it("update_kb_registry：干跑验证命中本智能体", async () => {
    const store = mockAgentStore();
    const created = await store.create({
      ownerId: USER.id,
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
    });
    let dryRunCalls = 0;
    const kbDir = freshKbDir();
    const deps: Deps = {
      ...baseDeps(store, kbDir),
      dispatchDryRun: async () => {
        dryRunCalls += 1;
        return { agentId: created.id, rationale: "匹配" };
      },
    };
    const r = await findTool(deps, "update_kb_registry").handler({
      agentId: created.id,
      name: "A",
      duty: "测试",
      skills: [],
      taskTypes: "code-dev",
    });
    expect(r.isError).toBeUndefined();
    expect(dryRunCalls).toBe(1);
    expect(r.content[0]?.text).toContain("干跑验证通过");
  });

  it("update_kb_registry：干跑仍为 none / 路由他处时给出修订指引", async () => {
    const store = mockAgentStore();
    const created = await store.create({
      ownerId: USER.id,
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
    });
    const noneRun: Deps = {
      ...baseDeps(store, freshKbDir()),
      dispatchDryRun: async () => ({ agentId: "none", rationale: "描述不清晰" }),
    };
    const none = await findTool(noneRun, "update_kb_registry").handler({
      agentId: created.id,
      name: "A",
      duty: "d",
      skills: [],
      taskTypes: "ops",
    });
    expect(none.isError).toBeUndefined();
    expect(none.content[0]?.text).toContain("仍路由到 none");
    const otherRun: Deps = {
      ...baseDeps(store, freshKbDir()),
      dispatchDryRun: async () => ({ agentId: "other-agent", rationale: "重叠" }),
    };
    const other = await findTool(otherRun, "update_kb_registry").handler({
      agentId: created.id,
      name: "A",
      duty: "d",
      skills: [],
      taskTypes: "ops",
    });
    expect(other.content[0]?.text).toContain("其他智能体");
  });

  it("update_kb_registry：干跑抛错不影响登记生效", async () => {
    const store = mockAgentStore();
    const created = await store.create({
      ownerId: USER.id,
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
    });
    const kbDir = freshKbDir();
    const deps: Deps = {
      ...baseDeps(store, kbDir),
      dispatchDryRun: async () => {
        throw new Error("dispatcher 超时");
      },
    };
    const r = await findTool(deps, "update_kb_registry").handler({
      agentId: created.id,
      name: "A",
      duty: "d",
      skills: [],
      taskTypes: "ops",
    });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toContain("登记本身已生效");
    expect(readFileSync(join(kbDir, "dispatcher", "agents.md"), "utf8")).toContain(created.id);
  });

  it("create_agent：tools 参数落库并回显；缺省 all", async () => {
    const store = mockAgentStore();
    const deps = baseDeps(store, KB_DIR);
    const r = await findTool(deps, "create_agent").handler({
      name: "RO",
      tools: { mode: "whitelist", whitelist: ["Read", "Glob", "Grep"] },
    });
    expect(r.content[0]?.text).toContain("工具白名单：Read、Glob、Grep");
    const all = await findTool(deps, "create_agent").handler({ name: "ALL" });
    expect(all.content[0]?.text).toContain("工具全开");
  });

  it("update_kb_registry：agentId 不存在或非本人智能体拒绝登记", async () => {
    const store = mockAgentStore();
    const deps = baseDeps(store, KB_DIR);
    const ghost = await findTool(deps, "update_kb_registry").handler({
      agentId: "ghost-id",
      name: "A",
      duty: "d",
      skills: [],
      taskTypes: "ops",
    });
    expect(ghost.isError).toBe(true);
    expect(ghost.content[0]?.text).toContain("智能体不存在");
    const created = await store.create({
      ownerId: "someone-else",
      name: "Foreign",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
    });
    const foreign = await findTool(deps, "update_kb_registry").handler({
      agentId: created.id,
      name: "Foreign",
      duty: "d",
      skills: [],
      taskTypes: "ops",
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0]?.text).toContain("只能登记");
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

  it("kbDir 缺省时 update_kb_registry 报错", async () => {
    const store = mockAgentStore();
    const created = await store.create({
      ownerId: USER.id,
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
    });
    const deps = baseDeps(store);
    const r = await findTool(deps, "update_kb_registry").handler({
      agentId: created.id,
      name: "A",
      duty: "d",
      skills: [],
      taskTypes: "ops",
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("kbDir");
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
    const deps: Deps = { ...baseDeps(store, KB_DIR), credentialSets: credentialSets as never };
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
    const deps = baseDeps(store, KB_DIR);
    const r = await findTool(deps, "create_agent").handler({ name: "dev", scenario: "code-dev" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toContain("至少绑定一个 git 仓库");
  });

  it("update_kb_registry：taskTypes 非法值报错并列出合法词表", async () => {
    const store = mockAgentStore();
    const created = await store.create({
      ownerId: USER.id,
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
    });
    const deps = baseDeps(store, KB_DIR);
    const r = await findTool(deps, "update_kb_registry").handler({
      agentId: created.id,
      name: "A",
      duty: "d",
      skills: [],
      taskTypes: "测试类",
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("code-dev");
    expect(r.content[0]?.text).toContain("测试类");
  });

  it("update_kb_registry：agent.scenario 与 taskTypes 不一致时提示", async () => {
    const store = mockAgentStore();
    const created = await store.create({
      ownerId: USER.id,
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
      scenario: "kb-qa",
    });
    const deps = baseDeps(store, freshKbDir());
    const r = await findTool(deps, "update_kb_registry").handler({
      agentId: created.id,
      name: "A",
      duty: "d",
      skills: [],
      taskTypes: "code-dev",
    });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toContain("不在登记的 taskTypes 中");
  });
});
