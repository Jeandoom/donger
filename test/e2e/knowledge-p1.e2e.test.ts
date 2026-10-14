import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentRunner, type FakeScript } from "../../src/adapters/fake-agent-runner.js";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { InMemoryUsageStore } from "../../src/adapters/in-memory-usage-store.js";
import {
  SqliteKbLibraryStore,
  SqliteKbRevisionStore,
  SqliteKbShareStore,
} from "../../src/adapters/sqlite-kb-store.js";
import { SqliteCredentialSetStore } from "../../src/adapters/sqlite-credential-set-store.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import type { Agent } from "../../src/domain/agent.js";
import type { Conversation } from "../../src/domain/conversation.js";
import { GateRouter } from "../../src/domain/gate-router.js";
import type { SkillPack } from "../../src/domain/skill-pack.js";
import type { OutgoingMessage } from "../../src/domain/types.js";
import { MemoryStore } from "../../src/memory/memory-store.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { RuntimeManager } from "../../src/orchestrator/runtime-manager.js";
import type { AgentRunner, ApprovalResolver, RunOptions } from "../../src/ports/agent-runner.js";
import type { RunnerEvent, Task } from "../../src/domain/types.js";
import type { Channel } from "../../src/ports/channel.js";
import type { ConversationStore } from "../../src/ports/conversation-store.js";
import type { SkillInstaller } from "../../src/ports/skill-installer.js";
import type { TranscriptStore } from "../../src/ports/transcript-store.js";
import type { User } from "../../src/domain/user.js";
import type { UserStore } from "../../src/ports/user-store.js";
import { kbRootDir } from "../../src/util/kb-files.js";
import { loadOrGenerateAppSecret } from "../../src/util/app-secret.js";

/**
 * 知识体系 P1 纵切验收：记忆通道三档（curated/legacy/off）与平台环境约束注入。
 * 真实 Orchestrator + RuntimeManager + Sqlite KB 三表 + 真实文件系统 MemoryStore。
 */

// ---- 捕获 RunOptions 的 runner（断言提示词注入用） ----

class CapturingRunner implements AgentRunner {
  lastOpts: RunOptions | undefined;
  constructor(private readonly inner: AgentRunner) {}
  run(task: Task, opts: RunOptions, approval: ApprovalResolver): AsyncIterable<RunnerEvent> {
    this.lastOpts = opts;
    return this.inner.run(task, opts, approval);
  }
}

// ---- 测试 harness（同 orchestrator.test.ts 家族 + kb 三表/memory 通道取值器） ----

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "donger-kp1-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function fakeChannel(approve = true): Channel & { sent: OutgoingMessage[] } {
  const sent: OutgoingMessage[] = [];
  return {
    id: "test",
    sent,
    onMessage: () => {},
    send: async (_t, m) => {
      sent.push(m);
    },
    requestApproval: async () => ({ approved: approve }),
  };
}

function mockUserStore(homeDir: string): UserStore {
  const users = new Map<string, User>();
  const identities = new Map<string, string>();
  const noop = async () => undefined;
  return {
    async get(id: string) {
      return users.get(id);
    },
    async list() {
      return [...users.values()];
    },
    async getOrCreateByIdentity(provider: string, externalId: string, name?: string) {
      const key = `${provider}:${externalId}`;
      const existingId = identities.get(key);
      const existing = existingId ? users.get(existingId) : undefined;
      if (existing) return existing;
      const id = `u-${externalId}`;
      const u: User = {
        id,
        name: name ?? externalId,
        role: "user",
        homeDir,
        createdAt: "t",
        updatedAt: "t",
      };
      users.set(id, u);
      identities.set(key, id);
      return u;
    },
    async isAdminByExternalId() {
      return false;
    },
    async findByIdentity(provider: string, externalId: string) {
      const id = identities.get(`${provider}:${externalId}`);
      return id ? users.get(id) : undefined;
    },
    async addIdentity() {},
    async getIdentities() {
      return [];
    },
    async updateProfile() {},
    async updateRole() {},
    async updateSidebarPrefs() {},
    async setPasswordCredential() {},
    async getPasswordCredential() {
      return undefined;
    },
    setEmailVerification: noop,
    getEmailVerification: noop,
    markEmailVerified: noop,
    async listEmailVerifications() {
      return [];
    },
    async hasAnyAdmin() {
      return false;
    },
    async hasAnyAdminExcluding() {
      return false;
    },
    async createBootstrapAdmin() {
      return "exists";
    },
  };
}

function agentConvStore(agentId: string, userId: string): ConversationStore {
  const conv: Conversation = {
    id: "conv-agent",
    userId,
    sdkSessionId: "",
    title: "agent 会话",
    channelId: "test",
    agentId,
    createdAt: "t",
    updatedAt: "t",
    archived: false,
  };
  return {
    async create() {
      return conv;
    },
    async get() {
      return conv;
    },
    async getVisible() {
      return conv;
    },
    async getLatest() {
      return conv;
    },
    async listByUser() {
      return [conv];
    },
    async createWithAgent() {
      return conv;
    },
    async update() {},
  };
}

function mockTranscriptStore(): TranscriptStore {
  return {
    async append() {},
    async load() {
      return null;
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

interface Harness {
  orch: Orchestrator;
  store: InMemoryTaskStore;
  runner: CapturingRunner;
  memoryRoot: () => Promise<string>;
  setMode: (m: "curated" | "legacy" | "off") => void;
  setNotes: (n: string | undefined) => void;
  waitForDone: () => Promise<void>;
}

function setup(opts: {
  script?: FakeScript;
  mode: "curated" | "legacy" | "off";
  notes?: string;
}): Harness {
  const { script = { result: "ok" }, mode, notes } = opts;
  let channelMode: "curated" | "legacy" | "off" = mode;
  let envNotes: string | undefined = notes;

  const userHome = join(tmp, "home");
  const workspaceDir = join(tmp, "workspace");
  mkdirSync(userHome, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  const store = new InMemoryTaskStore();
  const userStore = mockUserStore(userHome);
  const conversationStore = agentConvStore("a1", "u-webu");
  const db = new Database(":memory:");
  const kbLibraryStore = new SqliteKbLibraryStore(db);
  const kbShareStore = new SqliteKbShareStore(db);
  const kbRevisionStore = new SqliteKbRevisionStore(db);
  for (const s of [kbLibraryStore, kbShareStore, kbRevisionStore]) s.migrate();

  const packStore = new SqliteSkillPackStore(db);
  packStore.migrate();
  const credentialSets = SqliteCredentialSetStore.fromSeed(
    db,
    loadOrGenerateAppSecret(db, "skill_secret_key"),
  );
  credentialSets.migrate();
  const fakeInstaller: SkillInstaller = {
    installFromGit: async () => ({}) as SkillPack,
    installFromUpload: async () => ({}) as SkillPack,
    installFromPaste: async () => ({}) as SkillPack,
    installBuiltin: async () => ({}) as SkillPack,
    uninstall: async () => {},
    update: async () => ({}) as SkillPack,
    readSkillDoc: async () => "",
    updateSkillDoc: async () => ({}) as SkillPack,
  };
  const runtimeMgr = new RuntimeManager({
    transcriptStore: mockTranscriptStore(),
    conversationStore,
    config: {
      workspaceDir,
      llm: { model: "m", baseUrl: "u", authToken: "t" },
      defaultSystemPromptAppend: "测试默认 prompt",
      agentLlmPresets: [],
    },
    skillPackStore: packStore,
    credentialSets,
    installer: fakeInstaller,
    builtinSkillsDir: "",
  });

  const agent: Agent = {
    id: "a1",
    ownerId: "u-webu",
    name: "A",
    skills: [],
    connectorIds: [],
    defaultPermissionMode: "ask_before_change",
    tools: { mode: "all", whitelist: [] },
    mcpServers: [],
    credentials: [],
    gitRepositories: [],
    gitAllowShellGit: false,
    extensionDirectories: [],
    version: 1,
    createdAt: "",
    updatedAt: "",
  };
  const agentStore = {
    get: async () => agent,
    listByOwner: async () => [],
    listSharedWith: async () => [],
    create: async () => agent,
    update: async () => agent,
    delete: async () => {},
  } as unknown as import("../../src/ports/agent-store.js").AgentStore;
  const shareStore = {
    isGranted: async () => true,
  } as unknown as import("../../src/ports/agent-share-store.js").AgentShareStore;

  const runner = new CapturingRunner(new FakeAgentRunner(script));
  const gates = new GateRouter();
  const orch = new Orchestrator({
    store,
    userStore,
    conversationStore,
    usageStore: new InMemoryUsageStore(),
    auditStore: new InMemoryAuditStore(),
    gates,
    runner,
    channel: fakeChannel(),
    runtimeMgr,
    credentialSets,
    agentStore,
    agentShareStore: shareStore,
    kbLibraryStore,
    kbShareStore,
    kbRevisionStore,
    workspaceDir,
    memoryChannelMode: () => channelMode,
    platformEnvNotes: () => envNotes,
  });
  return {
    orch,
    store,
    runner,
    memoryRoot: async () => {
      // 与 orchestrator 同口径解析用户（processMessage: getOrCreateByIdentity("internal", requesterId)）
      const user = await userStore.getOrCreateByIdentity("internal", "u-webu", "u-webu");
      const personal = await kbLibraryStore.ensurePersonalLibrary(user.id);
      return join(kbRootDir(workspaceDir, personal.id), "memory");
    },
    setMode: (m) => {
      channelMode = m;
    },
    setNotes: (n) => {
      envNotes = n;
    },
    waitForDone: async () => {
      for (let i = 0; i < 200; i++) {
        if ((await store.listByStatus("done")).length > 0) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("任务未在时限内 done");
    },
  };
}

const MSG = { channelId: "test", threadId: "th", requesterId: "u-webu", text: "部署最新代码" };

describe("知识体系 P1：记忆通道三档 + 平台环境约束", () => {
  it("legacy：收尾倾倒落 memory/auto/ 子目录且 detail 截断 500 字；顶层无新文件", async () => {
    const h = setup({ mode: "legacy", script: { result: "长".repeat(800) } });
    await h.orch.handleMessage(MSG);
    await h.waitForDone();

    const memDir = await h.memoryRoot();
    expect(existsSync(memDir)).toBe(true);
    const topLevel = readdirSync(memDir).filter((f) => f.endsWith(".md"));
    expect(topLevel).toEqual([]);
    const autoDir = join(memDir, "auto");
    expect(existsSync(autoDir)).toBe(true);
    const dumps = readdirSync(autoDir).filter((f) => f.endsWith(".md"));
    expect(dumps.length).toBe(1);
    const text = readFileSync(join(autoDir, dumps[0]!), "utf8");
    expect(text).toContain("prompt: 部署最新代码");
    expect(text).toContain("长".repeat(500));
    expect(text).not.toContain("长".repeat(501));
  });

  it("curated（缺省）：收尾不倾倒原文；有索引时注入「长期记忆索引」节（P2）", async () => {
    const h = setup({ mode: "curated" });
    // 预置 curated 索引（P2 起注入源：索引进上下文，详情按需读取）
    const memDir = await h.memoryRoot();
    mkdirSync(join(memDir, "curated"), { recursive: true });
    writeFileSync(
      join(memDir, "curated", "INDEX.md"),
      "- [部署执行器方案](curated/a.md) — node ssh2 自写执行器\n",
      "utf8",
    );
    await h.orch.handleMessage(MSG);
    await h.waitForDone();

    // 不倾倒：顶层与 auto/ 均无 .md
    const hasMd = (d: string): boolean =>
      existsSync(d) && readdirSync(d).some((f) => f.endsWith(".md"));
    expect(hasMd(memDir)).toBe(false);
    expect(hasMd(join(memDir, "auto"))).toBe(false);
    // 注入：索引常驻节
    expect(h.runner.lastOpts?.systemPromptAppend).toContain("## 长期记忆索引");
    expect(h.runner.lastOpts?.systemPromptAppend).toContain("部署执行器方案");
    expect(h.runner.lastOpts?.systemPromptAppend).not.toContain("相关记忆");
  });

  it("off：不装配记忆（无注入、无落盘）", async () => {
    const h = setup({ mode: "off" });
    await h.orch.handleMessage(MSG);
    await h.waitForDone();
    expect(h.runner.lastOpts?.systemPromptAppend).not.toContain("相关记忆");
  });

  it("legacy 记忆命中注入「相关记忆」节（检索通道 P1 保持）", async () => {
    const h = setup({ mode: "legacy" });
    // 预置一条与 prompt 命中的记忆（MemoryStore 关键词检索语义）
    const m = new MemoryStore(await h.memoryRoot());
    m.append({ summary: "部署执行器方案（部署最新代码场景复用）", detail: "node ssh2" });
    await h.orch.handleMessage(MSG);
    await h.waitForDone();
    expect(h.runner.lastOpts?.systemPromptAppend).toContain("相关记忆");
    expect(h.runner.lastOpts?.systemPromptAppend).toContain("部署执行器方案");
  });

  it("平台环境约束注入：envNotes 非空进提示词，空不注入", async () => {
    const withNotes = setup({ mode: "curated", notes: "- 沙箱只有 node/npm/git" });
    await withNotes.orch.handleMessage(MSG);
    await withNotes.waitForDone();
    expect(withNotes.runner.lastOpts?.systemPromptAppend).toContain("## 平台环境约束");
    expect(withNotes.runner.lastOpts?.systemPromptAppend).toContain("沙箱只有 node/npm/git");

    const noNotes = setup({ mode: "curated", notes: undefined });
    await noNotes.orch.handleMessage(MSG);
    await noNotes.waitForDone();
    expect(noNotes.runner.lastOpts?.systemPromptAppend ?? "").not.toContain("平台环境约束");
  });
});
