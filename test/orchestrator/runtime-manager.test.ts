import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteCredentialStore } from "../../src/adapters/sqlite-credential-store.js";
import { LocalExtensionDirectoryResolver } from "../../src/adapters/local-extension-directory-resolver.js";
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
  const credentialStore = new SqliteCredentialStore(
    db,
    loadOrGenerateAppSecret(db, "skill_secret_key"),
  );
  credentialStore.migrate();
  return {
    skillPackStore: packStore,
    credentialStore,
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
  let credStore: SqliteCredentialStore;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "rtmgr-"));
    db = new Database(":memory:");
    packStore = new SqliteSkillPackStore(db);
    packStore.migrate();
    credStore = new SqliteCredentialStore(db, loadOrGenerateAppSecret(db, "skill_secret_key"));
    credStore.migrate();
  });

  function makeMgr(convStore: ReturnType<typeof fakeConvStore>) {
    return new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: convStore as unknown as ConversationStore,
      config: baseConfig(ws),
      skillPackStore: packStore,
      credentialStore: credStore,
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

  it("prepare：启用 pack 的路径/白名单/凭证进入 runOptions", async () => {
    await packStore.upsertPack(mkPack());
    await packStore.upsertSkills("u1", "p1", [mkSkill()]);
    await credStore.setValue("u1", "K", "v");
    const m = makeMgr(fakeConvStore([baseConv()]));
    const { runOptions } = await m.prepare(baseUser(join(ws, "users", "u1")), baseConv(), {});
    expect(runOptions.pluginPaths?.some((p) => p.endsWith(join(".skills", "demo")))).toBe(true);
    expect(runOptions.skills).toEqual(["demo:alpha"]);
    expect(runOptions.credentialsEnv?.K).toBe("v");
    expect(runOptions.resume).toBeUndefined();
    expect(runOptions.sessionStore).toBeDefined();
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

  it("missingCredentialItems：仅返回缺失的 required 项（带 packName）", async () => {
    await packStore.upsertPack(
      mkPack({
        credentials: [
          { key: "REQ", label: "R", required: true, secret: true },
          { key: "OPT", label: "O", required: false, secret: true },
        ],
      }),
    );
    await credStore.setValue("u1", "REQ", "v");
    const m = makeMgr(fakeConvStore([baseConv()]));
    const items = await m.missingCredentialItems("u1");
    // REQ 已配、OPT 非必需 → 均不出现
    expect(items).toEqual([]);
    // 再加一个未配的 required
    await packStore.upsertPack(
      mkPack({
        id: "p2",
        slug: "demo2",
        name: "demo2",
        credentials: [{ key: "MISS", label: "M", required: true, secret: true }],
      }),
    );
    const items2 = await m.missingCredentialItems("u1");
    expect(items2).toEqual([
      { key: "MISS", label: "M", description: undefined, secret: true, packName: "demo2" },
    ]);
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

  it("传 agent 时 skills/systemPrompt/llm/allowedTools/mcpServers 覆盖", async () => {
    const conv = baseConv({ agentId: "a1" });
    const convStore = fakeConvStore([conv]);
    const m = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: convStore as unknown as ConversationStore,
      config: baseConfig(ws, {
        agentLlmPresets: [{ id: "p1", name: "GLM", model: "glm-4.6", baseUrl: "https://a" }],
      }),
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
        llm: { presetId: "p1" },
        createdAt: "",
        updatedAt: "",
      },
    });
    expect(runOptions.skills).toEqual(["s:1"]);
    expect(runOptions.llm.model).toBe("glm-4.6");
    expect(runOptions.llm.baseUrl).toBe("https://a");
    expect(runOptions.allowedTools).toEqual(["Bash"]);
    expect(runOptions.mcpServers?.[0]?.name).toBe("m");
    expect(runOptions.systemPromptAppend).toContain("EXTRA");
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
        llm: {},
        createdAt: "",
        updatedAt: "",
      },
    });
    expect(runOptions.allowedTools).toBeUndefined();
    expect(runOptions.mcpServers).toBeUndefined();
  });

  it("owner 的扩展目录进入 SDK additionalDirectories 和写入根", async () => {
    const conv = baseConv({ agentId: "a1" });
    const extension = mkdtempSync(join(tmpdir(), "runtime-extension-"));
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
        gitRepositories: [],
        extensionDirectories: [{ id: "d1", name: "代码", path: extension, access: "readWrite" }],
        llm: {},
        createdAt: "",
        updatedAt: "",
      },
    });
    expect(runOptions.additionalDirectories).toEqual([extension]);
    expect(runOptions.allowedWriteRoots).toEqual([extension]);
    expect(runOptions.systemPromptAppend).toContain("扩展工作目录");
  });
});
