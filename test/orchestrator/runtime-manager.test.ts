import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { LocalExtensionDirectoryResolver } from "../../src/adapters/local-extension-directory-resolver.js";
import { SqliteCredentialSetStore } from "../../src/adapters/sqlite-credential-set-store.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import type { Conversation } from "../../src/domain/conversation.js";
import type { PackSkill, SkillPack } from "../../src/domain/skill-pack.js";
import {
  RuntimeManager,
  type RuntimeManagerConfig,
} from "../../src/orchestrator/runtime-manager.js";
import type { ConversationStore } from "../../src/ports/conversation-store.js";
import type { SkillInstaller } from "../../src/ports/skill-installer.js";
import type { TranscriptStore } from "../../src/ports/transcript-store.js";
import { loadOrGenerateAppSecret } from "../../src/util/app-secret.js";

/** 内存 ConversationStore */
function fakeConvStore(initial: Conversation[] = []) {
  const map = new Map(initial.map((c) => [c.id, c]));
  return {
    async get(id: string) {
      return map.get(id);
    },
    async update(id: string, patch: Partial<Conversation>) {
      const c = map.get(id);
      if (c) map.set(id, { ...c, ...patch, updatedAt: new Date().toISOString() });
    },
    snapshot: (id: string) => map.get(id),
  };
}

/** 内存 TranscriptStore（只够 getTranscript 用） */
function fakeTranscriptStore(loadImpl: (key: { sessionId: string }) => unknown): TranscriptStore {
  return {
    async append() {},
    async load(key) {
      return loadImpl(key) as never;
    },
    async listSessions() {
      return [];
    },
    async latestSessionForConversation() {
      return null;
    },
    async listSubkeys() {
      return [];
    },
    async delete() {},
  };
}

const fakeInstaller: SkillInstaller = {
  installFromGit: async () => ({}) as SkillPack,
  installFromUpload: async () => ({}) as SkillPack,
  installFromPaste: async () => ({}) as SkillPack,
  installBuiltin: async () => ({}) as SkillPack,
  uninstall: async () => {},
  update: async () => ({}) as SkillPack,
};

const baseConv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  userId: "u1",
  sdkSessionId: "",
  title: "t",
  channelId: "web",
  agentId: "",
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
  archived: false,
  ...over,
});

const baseUser = (homeDir: string) => ({
  id: "u1",
  name: "tester",
  role: "user" as const,
  homeDir,
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
});

const baseConfig = (
  ws: string,
  over: Partial<RuntimeManagerConfig> = {},
): RuntimeManagerConfig => ({
  workspaceDir: ws,
  llm: { model: "glm", baseUrl: "http://x", authToken: "t" },
  defaultSystemPromptAppend: "高危操作触发审批门。",
  agentLlmPresets: [],
  ...over,
});

/** 空 skill 依赖（agent 分支测试不关心 pack，仅满足 prepare 所需 deps）。 */
function emptySkillDeps() {
  const db = new Database(":memory:");
  const packStore = new SqliteSkillPackStore(db);
  packStore.migrate();
  const credentialSets = new SqliteCredentialSetStore(
    db,
    loadOrGenerateAppSecret(db, "skill_secret_key"),
  );
  credentialSets.migrate();
  return {
    skillPackStore: packStore,
    credentialSets,
    installer: {
      installFromGit: async () => ({}) as SkillPack,
      installFromUpload: async () => ({}) as SkillPack,
      installFromPaste: async () => ({}) as SkillPack,
      installBuiltin: async () => ({}) as SkillPack,
      uninstall: async () => {},
      update: async () => ({}) as SkillPack,
    } as SkillInstaller,
    builtinSkillsDir: "",
  };
}

describe("RuntimeManager", () => {
  let ws: string;
  let db: Database.Database;
  let packStore: SqliteSkillPackStore;
  let credStore: SqliteCredentialSetStore;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "rtmgr-"));
    db = new Database(":memory:");
    packStore = new SqliteSkillPackStore(db);
    packStore.migrate();
    credStore = new SqliteCredentialSetStore(db, loadOrGenerateAppSecret(db, "skill_secret_key"));
    credStore.migrate();
  });

  function makeMgr(convStore: ReturnType<typeof fakeConvStore>) {
    return new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: convStore as unknown as ConversationStore,
      config: baseConfig(ws),
      skillPackStore: packStore,
      credentialSets: credStore,
      installer: fakeInstaller,
      builtinSkillsDir: "",
    });
  }

  function mkPack(over: Partial<SkillPack> = {}): SkillPack {
    return {
      id: "p1",
      userId: "u1",
      slug: "demo",
      name: "demo",
      source: { kind: "paste" },
      installedPath: ".skills/demo",
      enabled: true,
      builtin: false,
      credentials: [{ key: "K", label: "K", required: true, secret: true }],
      createdAt: "t",
      updatedAt: "t",
      ...over,
    };
  }
  function mkSkill(over: Partial<PackSkill> = {}): PackSkill {
    return {
      id: "s1",
      userId: "u1",
      packId: "p1",
      name: "alpha",
      description: "d",
      relativePath: "skills/alpha/SKILL.md",
      enabled: true,
      createdAt: "t",
      updatedAt: "t",
      ...over,
    };
  }

  it("prepare：启用 pack 的路径/白名单进入 runOptions；agent 勾选凭证注入 env", async () => {
    await packStore.upsertPack(mkPack());
    await packStore.upsertSkills("u1", "p1", [mkSkill()]);
    await credStore.createTemplate(
      "c1",
      {
        name: "凭证一",
        keySpecs: [{ key: "K" }],
      },
      "u1",
    );
    await credStore.createTemplate(
      "c2",
      {
        name: "凭证二",
        keySpecs: [{ key: "X" }],
      },
      "u1",
    );
    await credStore.upsertValue("u1", "c1", { K: "v" });
    const m = makeMgr(fakeConvStore([baseConv()]));
    const agent = {
      id: "a1",
      ownerId: "u1",
      name: "ag",
      skills: [] as string[],
      tools: { mode: "all" as const, whitelist: [] },
      mcpServers: [],
      credentials: ["c1", "c2"],
      gitRepositories: [],
      gitAllowShellGit: false,
      extensionDirectories: [],
      version: 1,
      createdAt: "t",
      updatedAt: "t",
    };
    const { runOptions } = await m.prepare(baseUser(join(ws, "users", "u1")), baseConv(), {
      agent,
    });
    expect(runOptions.pluginPaths?.some((p) => p.endsWith(join(".skills", "demo")))).toBe(true);
    expect(runOptions.skills).toEqual(["demo:alpha"]);
    // 命中：K 平铺；未配置：c2 注入 MISSING 标记
    expect(runOptions.credentialsEnv?.C1_K).toBe("v");
    expect(runOptions.credentialsEnv?.C2_MISSING).toBe("1");
    expect(runOptions.resume).toBeUndefined();
    expect(runOptions.sessionStore).toBeDefined();
  });

  it("prepare：git 类凭证（kind=git）不注入 env，token 仅凭证桥现取", async () => {
    await credStore.createTemplate(
      "generic-ak",
      { name: "普通凭证", keySpecs: [{ key: "K" }] },
      "u1",
    );
    await credStore.createTemplate(
      "git-pat",
      { name: "git PAT", kind: "git", keySpecs: [{ key: "token" }] },
      "u1",
    );
    await credStore.upsertValue("u1", "generic-ak", { K: "v" });
    await credStore.upsertValue("u1", "git-pat", { token: "secret-token" });
    const m = makeMgr(fakeConvStore([baseConv()]));
    const agent = {
      id: "a1",
      ownerId: "u1",
      name: "ag",
      skills: [] as string[],
      tools: { mode: "all" as const, whitelist: [] },
      mcpServers: [],
      credentials: ["generic-ak", "git-pat"],
      gitRepositories: [],
      gitAllowShellGit: false,
      extensionDirectories: [],
      version: 1,
      createdAt: "t",
      updatedAt: "t",
    };
    const { runOptions } = await m.prepare(baseUser(join(ws, "users", "u1")), baseConv(), {
      agent,
    });
    // generic 照常注入；git 类的任何形态（平铺/整体 JSON/_MISSING）都不出现
    expect(runOptions.credentialsEnv?.GENERIC_AK_K).toBe("v");
    expect(runOptions.credentialsEnv?.GIT_PAT_TOKEN).toBeUndefined();
    expect(runOptions.credentialsEnv?.GIT_PAT).toBeUndefined();
    expect(runOptions.credentialsEnv?.GIT_PAT_MISSING).toBeUndefined();
    expect(JSON.stringify(runOptions.credentialsEnv)).not.toContain("secret-token");
  });

  it("prepare：插件 scripts/ 共享运行库 → pythonPaths 注入（复盘 P2-10）", async () => {
    await packStore.upsertPack(mkPack());
    await packStore.upsertSkills("u1", "p1", [mkSkill()]);
    const packDir = join(ws, "users", "u1", ".skills", "demo");
    mkdirSync(join(packDir, "scripts", "credentials"), { recursive: true });
    writeFileSync(join(packDir, "scripts", "credentials", "__init__.py"), "");
    const m = makeMgr(fakeConvStore([baseConv()]));
    const { runOptions } = await m.prepare(baseUser(join(ws, "users", "u1")), baseConv(), {});
    expect(runOptions.pythonPaths).toEqual([join(packDir, "scripts")]);
  });

  it("prepare：停用 pack → 不进 pluginPaths/白名单", async () => {
    await packStore.upsertPack(mkPack({ enabled: false }));
    await packStore.upsertSkills("u1", "p1", [mkSkill()]);
    const m = makeMgr(fakeConvStore([baseConv()]));
    const { runOptions } = await m.prepare(baseUser(join(ws, "users", "u1")), baseConv(), {});
    expect(runOptions.pluginPaths).toEqual([]);
    expect(runOptions.skills).toEqual([]);
  });

  it("prepare：停用单个 skill → pack 路径在但该 skill 不进白名单", async () => {
    await packStore.upsertPack(mkPack());
    await packStore.upsertSkills("u1", "p1", [
      mkSkill(),
      mkSkill({ id: "s2", name: "beta", enabled: false }),
    ]);
    const m = makeMgr(fakeConvStore([baseConv()]));
    const { runOptions } = await m.prepare(baseUser(join(ws, "users", "u1")), baseConv(), {});
    expect(runOptions.skills).toEqual(["demo:alpha"]);
  });

  it("prepare：续接会话(有 sdkSessionId)产出 resume", async () => {
    const conv = baseConv({ sdkSessionId: "sdk-xyz" });
    const m = makeMgr(fakeConvStore([conv]));
    const { runOptions } = await m.prepare(baseUser(join(ws, "users", "u1")), conv, {});
    expect(runOptions.resume).toBe("sdk-xyz");
  });

  it("inspectCredentials：仅返回缺失项的模板元数据（不含值）", async () => {
    await credStore.createTemplate(
      "hit",
      {
        name: "已配置",
        keySpecs: [{ key: "K" }],
      },
      "u1",
    );
    await credStore.createTemplate(
      "miss",
      {
        name: "未配置",
        description: "说明",
        keySpecs: [{ key: "K" }, { key: "S" }],
      },
      "u1",
    );
    await credStore.upsertValue("u1", "hit", { K: "v" });
    const m = makeMgr(fakeConvStore([baseConv()]));
    const items = await m.inspectCredentials("u1", ["hit", "miss"]);
    expect(items).toEqual([
      { code: "miss", name: "未配置", description: "说明", keys: ["K", "S"] },
    ]);
    // 全命中 → 空
    expect(await m.inspectCredentials("u1", ["hit"])).toEqual([]);
    expect(await m.inspectCredentials("u1", [])).toEqual([]);
  });

  it("commit：回写 sdkSessionId 到 ConversationStore", async () => {
    const convStore = fakeConvStore([baseConv()]);
    const m = makeMgr(convStore);
    await m.commit("c1", { sdkSessionId: "sdk-new" });
    expect(convStore.snapshot("c1")?.sdkSessionId).toBe("sdk-new");
  });

  it("clearResume：清空 sdkSessionId（session 过期重试用）", async () => {
    const convStore = fakeConvStore([baseConv({ sdkSessionId: "stale" })]);
    const m = makeMgr(convStore);
    await m.clearResume("c1");
    expect(convStore.snapshot("c1")?.sdkSessionId).toBe("");
  });
});

describe("RuntimeManager agent 分支", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "rtmgr-"));
  });

  it("使用用户默认 LLM provider 覆盖系统默认（models[0] 作默认模型）", async () => {
    const conv = baseConv();
    const convStore = fakeConvStore([conv]);
    const llmProviderStore = {
      migrate() {},
      async list() {
        return [];
      },
      async getWithKey() {
        return undefined;
      },
      async findDefaultWithKey() {
        return {
          id: "p1",
          userId: "u1",
          name: "我的配置",
          platform: "custom",
          baseUrl: "https://user-llm.example.com/anthropic",
          key: "user-key",
          models: ["claude-sonnet", "claude-haiku"],
          sdkType: "anthropic" as const,
          isDefault: true,
          createdAt: "",
          updatedAt: "",
        };
      },
      async create() {
        throw new Error("unused");
      },
      async update() {
        return undefined;
      },
      async remove() {
        return false;
      },
    };
    const m = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: convStore as unknown as ConversationStore,
      config: baseConfig(ws),
      ...emptySkillDeps(),
      llmProviderStore,
    });

    const { runOptions } = await m.prepare(baseUser(join(ws, "users", "u1")), conv, {});
    expect(runOptions.llm).toEqual({
      model: "claude-sonnet",
      baseUrl: "https://user-llm.example.com/anthropic",
      authToken: "user-key",
      sdkType: "anthropic",
    });
  });

  it("M2：显式 modelRef（provider）优先于基底，且回写 lastModelRef", async () => {
    const conv = baseConv({ agentId: "a1" });
    const convStore = fakeConvStore([conv]);
    const provider = {
      id: "prov-1",
      userId: "u1",
      name: "我的智谱",
      platform: "zhipu-cn",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      key: "prov-key",
      models: ["glm-4.6", "glm-4.5"],
      sdkType: "anthropic" as const,
      isDefault: false,
      createdAt: "",
      updatedAt: "",
    };
    const llmProviderStore = {
      migrate() {},
      async list() {
        return [];
      },
      async getWithKey(_userId: string, id: string) {
        return id === provider.id ? provider : undefined;
      },
      async findDefaultWithKey() {
        return undefined;
      },
      async create() {
        throw new Error("unused");
      },
      async update() {
        return undefined;
      },
      async remove() {
        return false;
      },
    };
    const m = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: convStore as unknown as ConversationStore,
      config: baseConfig(ws),
      ...emptySkillDeps(),
      llmProviderStore,
    });
    const agent = {
      id: "a1",
      ownerId: "u1",
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      createdAt: "",
      updatedAt: "",
    };
    const user = baseUser(join(ws, "users", "u1"));
    const { runOptions } = await m.prepare(user, conv, {
      agent: agent as never,
      modelRef: "provider:prov-1:glm-4.5",
    });
    expect(runOptions.llm).toEqual({
      model: "glm-4.5",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      authToken: "prov-key",
      sdkType: "anthropic",
    });
    expect(convStore.snapshot(conv.id)?.lastModelRef).toBe("provider:prov-1:glm-4.5");
  });

  it("M2：显式 modelRef 无效（非本人 provider）抛错；lastModelRef 失效静默降级", async () => {
    const conv = baseConv({ lastModelRef: "provider:gone:m" });
    const convStore = fakeConvStore([conv]);
    const llmProviderStore = {
      migrate() {},
      async list() {
        return [];
      },
      async getWithKey() {
        return undefined;
      },
      async findDefaultWithKey() {
        return undefined;
      },
      async create() {
        throw new Error("unused");
      },
      async update() {
        return undefined;
      },
      async remove() {
        return false;
      },
    };
    const m = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: convStore as unknown as ConversationStore,
      config: baseConfig(ws),
      ...emptySkillDeps(),
      llmProviderStore,
    });
    const user = baseUser(join(ws, "users", "u1"));
    // 显式无效：抛错（用户可感知）
    await expect(m.prepare(user, conv, { modelRef: "provider:gone:m" })).rejects.toThrow(
      /所选模型不可用/,
    );
    // 历史失效（无显式）：静默降级到全局默认
    const { runOptions } = await m.prepare(user, conv, {});
    expect(runOptions.llm.model).toBe(baseConfig(ws).llm.model);
  });

  it("传 agent 时 skills/systemPrompt/allowedTools/mcpServers 覆盖", async () => {
    const conv = baseConv({ agentId: "a1" });
    const convStore = fakeConvStore([conv]);
    const m = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: convStore as unknown as ConversationStore,
      config: baseConfig(ws),
      ...emptySkillDeps(),
    });
    const { runOptions } = await m.prepare(baseUser(join(ws, "users", "u1")), conv, {
      agent: {
        id: "a1",
        ownerId: "u1",
        name: "A",
        systemPrompt: "EXTRA",
        skills: ["s:1"],
        tools: { mode: "whitelist", whitelist: ["Bash"] },
        mcpServers: [{ name: "m", type: "http", url: "https://x" }],
        createdAt: "",
        updatedAt: "",
      },
    });
    expect(runOptions.skills).toEqual(["s:1"]);
    expect(runOptions.allowedTools).toEqual(["Bash"]);
    expect(runOptions.mcpServers?.[0]?.name).toBe("m");
    expect(runOptions.systemPromptAppend).toContain("EXTRA");
  });

  it("cwd：agent 任务共享 agents/<agentId>/workspace（产物跨会话延续），无 agent 保持会话级", async () => {
    const user = baseUser(join(ws, "users", "u1"));
    const m = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: fakeConvStore([baseConv()]) as unknown as ConversationStore,
      config: baseConfig(ws),
      ...emptySkillDeps(),
    });
    const agent = {
      id: "a1",
      ownerId: "u1",
      name: "A",
      skills: [],
      tools: { mode: "all" as const, whitelist: [] },
      mcpServers: [],
      createdAt: "",
      updatedAt: "",
    };
    const withAgent1 = await m.prepare(user, baseConv(), { agent });
    const withAgent2 = await m.prepare(user, baseConv({ id: "conv-2" }), { agent });
    // 同 agent 不同会话 → 同一工作区（跨会话产物延续）
    expect(withAgent1.runOptions.cwd).toBe(withAgent2.runOptions.cwd);
    expect(withAgent1.runOptions.cwd).toContain(join("agents", "a1", "workspace"));
    const noAgent = await m.prepare(user, baseConv(), {});
    expect(noAgent.runOptions.cwd).toContain(join("sessions", "c1", "workspace"));
  });

  it("共享 agent 将创建者选中的 skill 复制到访问者会话目录", async () => {
    const ownerPackDir = mkdtempSync(join(tmpdir(), "shared-agent-pack-"));
    mkdirSync(join(ownerPackDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(ownerPackDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "owner-pack", version: "0.1.0" }),
    );
    mkdirSync(join(ownerPackDir, "skills", "query"), { recursive: true });
    writeFileSync(
      join(ownerPackDir, "skills", "query", "SKILL.md"),
      "---\nname: query\ndescription: query\n---\n",
    );

    const owner = {
      ...baseUser(mkdtempSync(join(tmpdir(), "shared-agent-owner-"))),
      id: "owner",
    };
    const skillDeps = emptySkillDeps();
    const ownerPack: SkillPack = {
      id: "owner-pack-id",
      userId: owner.id,
      slug: "owner-pack",
      name: "owner-pack",
      source: { kind: "paste" },
      installedPath: ownerPackDir,
      enabled: true,
      builtin: false,
      credentials: [],
      createdAt: "t",
      updatedAt: "t",
    };
    await skillDeps.skillPackStore.upsertPack(ownerPack);
    await skillDeps.skillPackStore.upsertSkills(owner.id, ownerPack.id, [
      {
        id: "owner-skill-id",
        userId: owner.id,
        packId: ownerPack.id,
        name: "query",
        description: "query",
        relativePath: "skills/query/SKILL.md",
        enabled: true,
        createdAt: "t",
        updatedAt: "t",
      },
    ]);

    const conv = baseConv();
    const visitor = baseUser(join(ws, "users", "u1"));
    const m = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: fakeConvStore([conv]) as unknown as ConversationStore,
      config: baseConfig(ws),
      ...skillDeps,
    });
    const { runOptions } = await m.prepare(visitor, conv, {
      agent: {
        id: "shared-agent",
        ownerId: owner.id,
        name: "共享助手",
        skills: ["owner-pack:query"],
        tools: { mode: "all", whitelist: [] },
        mcpServers: [],
        createdAt: "",
        updatedAt: "",
      },
      sharedAgentSkillOwner: owner,
    });

    const sharedPlugin = runOptions.pluginPaths?.find((path) =>
      path.includes(".donger-shared-skills"),
    );
    expect(sharedPlugin).toBeDefined();
    expect(existsSync(join(sharedPlugin ?? "", "skills", "query", "SKILL.md"))).toBe(true);
  });

  it("agent.tools.mode=all → allowedTools undefined", async () => {
    const conv = baseConv({ agentId: "a1" });
    const convStore = fakeConvStore([conv]);
    const m = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: convStore as unknown as ConversationStore,
      config: baseConfig(ws, { agentLlmPresets: [] }),
      ...emptySkillDeps(),
    });
    const { runOptions } = await m.prepare(baseUser(join(ws, "users", "u1")), conv, {
      agent: {
        id: "a1",
        ownerId: "u1",
        name: "A",
        skills: [],
        tools: { mode: "all", whitelist: [] },
        mcpServers: [],
        createdAt: "",
        updatedAt: "",
      },
    });
    expect(runOptions.allowedTools).toBeUndefined();
    expect(runOptions.mcpServers).toBeUndefined();
  });

  it("owner 的扩展目录进入 SDK additionalDirectories 和写入根", async () => {
    const conv = baseConv({ agentId: "a1" });
    const home = join(ws, "users", "u1");
    // 扩展目录已改版为相对路径：锚定属主工作区根，先落一个真实子目录
    mkdirSync(join(home, "ext-code"), { recursive: true });
    const extension = join(home, "ext-code");
    const m = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: fakeConvStore([conv]) as unknown as ConversationStore,
      config: baseConfig(ws),
      extensionDirectoryResolver: new LocalExtensionDirectoryResolver(),
      ...emptySkillDeps(),
    });
    const { runOptions } = await m.prepare(baseUser(home), conv, {
      agent: {
        id: "a1",
        ownerId: "u1",
        name: "A",
        skills: [],
        tools: { mode: "all", whitelist: [] },
        mcpServers: [],
        credentials: [],
        gitRepositories: [],
        gitAllowShellGit: false,
        extensionDirectories: [{ id: "d1", name: "代码", path: "ext-code", access: "readWrite" }],
        version: 1,
        createdAt: "",
        updatedAt: "",
      },
    });
    expect(runOptions.additionalDirectories).toEqual([extension]);
    expect(runOptions.allowedWriteRoots).toEqual([extension]);
    expect(runOptions.systemPromptAppend).toContain("扩展工作目录");
  });

  it("存量绝对路径扩展目录降级 unavailable，不注入 additionalDirectories", async () => {
    const conv = baseConv({ agentId: "a1" });
    const m = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: fakeConvStore([conv]) as unknown as ConversationStore,
      config: baseConfig(ws),
      extensionDirectoryResolver: new LocalExtensionDirectoryResolver(),
      ...emptySkillDeps(),
    });
    const { runOptions } = await m.prepare(baseUser(join(ws, "users", "u1")), conv, {
      agent: {
        id: "a1",
        ownerId: "u1",
        name: "A",
        skills: [],
        tools: { mode: "all", whitelist: [] },
        mcpServers: [],
        credentials: [],
        gitRepositories: [],
        gitAllowShellGit: false,
        extensionDirectories: [
          { id: "d1", name: "旧目录", path: "D:\\legacy\\dir", access: "readWrite" },
        ],
        version: 1,
        createdAt: "",
        updatedAt: "",
      },
    });
    expect(runOptions.additionalDirectories).toEqual([]);
    expect(runOptions.allowedWriteRoots).toEqual([]);
    expect(runOptions.systemPromptAppend).toContain("不可用");
  });
});
