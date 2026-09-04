import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Agent, AgentInput } from "../../src/domain/agent.js";
import type { SkillPack } from "../../src/domain/skill-pack.js";
import type { User } from "../../src/domain/user.js";
import { ensureDispatcherKb } from "../../src/orchestrator/dispatch-kb.js";
import { platformToolDefinitions } from "../../src/orchestrator/platform-tools.js";
import type { AgentStore } from "../../src/ports/agent-store.js";
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
      taskTypes: "测试类",
    };
    const r = await findTool(deps, "update_kb_registry").handler(args);
    expect(r.isError).toBeUndefined();
    const md = readFileSync(join(KB_DIR, "dispatcher", "agents.md"), "utf8");
    expect(md).toContain(`| ${created.id} | A | 测试 | a-execute | 测试类 | 无 |`);
    const dup = await findTool(deps, "update_kb_registry").handler(args);
    expect(dup.isError).toBe(true);
  });

  it("kbDir 缺省时 update_kb_registry 报错", async () => {
    const store = mockAgentStore();
    const deps = baseDeps(store);
    const r = await findTool(deps, "update_kb_registry").handler({
      agentId: "x",
      name: "A",
      duty: "d",
      skills: [],
      taskTypes: "t",
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("kbDir");
  });
});
