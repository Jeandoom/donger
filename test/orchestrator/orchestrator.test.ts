import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { FakeAgentRunner, type FakeScript } from "../../src/adapters/fake-agent-runner.js";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { InMemoryUsageStore } from "../../src/adapters/in-memory-usage-store.js";
import { SqliteCredentialSetStore } from "../../src/adapters/sqlite-credential-set-store.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import type { Conversation } from "../../src/domain/conversation.js";
import { GateRouter } from "../../src/domain/gate-router.js";
import type { SkillPack } from "../../src/domain/skill-pack.js";
import type { ApprovalCard, OutgoingMessage } from "../../src/domain/types.js";
import type { User, UserRole } from "../../src/domain/user.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { RuntimeManager } from "../../src/orchestrator/runtime-manager.js";
import type { AgentRunner } from "../../src/ports/agent-runner.js";
import type { Channel } from "../../src/ports/channel.js";
import type { ConversationStore } from "../../src/ports/conversation-store.js";
import type { SkillInstaller } from "../../src/ports/skill-installer.js";
import type { TranscriptStore } from "../../src/ports/transcript-store.js";
import type { UserStore } from "../../src/ports/user-store.js";
import { loadOrGenerateAppSecret } from "../../src/util/app-secret.js";

function fakeChannel(approve: boolean): Channel & {
  sent: OutgoingMessage[];
  cards: ApprovalCard[];
} {
  const sent: OutgoingMessage[] = [];
  const cards: ApprovalCard[] = [];
  return {
    id: "test",
    sent,
    cards,
    onMessage: () => {},
    send: async (_t, m) => {
      sent.push(m);
    },
    requestApproval: async (_t, c) => {
      cards.push(c);
      return { approved: approve };
    },
  };
}

function mockUserStore(): UserStore {
  const dir = mkdtempSync(join(tmpdir(), "donger-test-user-"));
  const users = new Map<string, User>();
  // identity key (provider:externalId) → userId
  const identities = new Map<string, string>();
  return {
    async get(id) {
      return users.get(id);
    },
    async list() {
      return [...users.values()];
    },
    async getOrCreateByIdentity(provider, externalId, name) {
      const key = `${provider}:${externalId}`;
      const existingId = identities.get(key);
      const existing = existingId ? users.get(existingId) : undefined;
      if (existing) return existing;
      const id = `u-${externalId}`;
      const u: User = {
        id,
        name: name ?? externalId,
        role: "user" as UserRole,
        homeDir: dir,
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
    async findByIdentity(provider, externalId) {
      const id = identities.get(`${provider}:${externalId}`);
      return id ? users.get(id) : undefined;
    },
    async addIdentity() {},
    async getIdentities() {
      return [];
    },
    async updateProfile() {},
    async updateRole() {},
  };
}

function mockConversationStore(): ConversationStore {
  const conv: Conversation = {
    id: "conv-1",
    userId: "u",
    sdkSessionId: "",
    title: "测试",
    channelId: "test",
    createdAt: "t",
    updatedAt: "t",
    archived: false,
  };
  return {
    async create() {
      return conv;
    },
    async get() {
      return undefined;
    },
    async getLatest() {
      return conv;
    },
    async listByUser() {
      return [];
    },
    async update() {},
  };
}

/** 内存 TranscriptStore（测试用，不落盘） */
function mockTranscriptStore(): TranscriptStore {
  return {
    async append() {},
    async load() {
      return null;
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

/** 构造真实 RuntimeManager + 其依赖的 credentialSets（内存 transcript + 内存 skill/credential store，model=m） */
function makeRuntimeMgr(conversationStore: ConversationStore): {
  mgr: RuntimeManager;
  credentialSets: SqliteCredentialSetStore;
} {
  const db = new Database(":memory:");
  const packStore = new SqliteSkillPackStore(db);
  packStore.migrate();
  const credentialSets = new SqliteCredentialSetStore(
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
  };
  const mgr = new RuntimeManager({
    transcriptStore: mockTranscriptStore(),
    conversationStore,
    config: {
      workspaceDir: mkdtempSync(join(tmpdir(), "donger-test-ws-")),
      llm: { model: "m", baseUrl: "u", authToken: "t" },
      defaultSystemPromptAppend: "测试默认 prompt",
      agentLlmPresets: [],
    },
    skillPackStore: packStore,
    credentialSets,
    installer: fakeInstaller,
    builtinSkillsDir: "",
  });
  return { mgr, credentialSets };
}

function setup(approve: boolean, script: FakeScript, customRunner?: AgentRunner) {
  const store = new InMemoryTaskStore();
  const usageStore = new InMemoryUsageStore();
  const auditStore = new InMemoryAuditStore();
  const channel = fakeChannel(approve);
  const runner = customRunner ?? new FakeAgentRunner(script);
  const gates = new GateRouter();
  gates.describe({ id: "design", description: "方案审批" });
  const conversationStore = mockConversationStore();
  const { mgr: runtimeMgr, credentialSets } = makeRuntimeMgr(conversationStore);
  const orch = new Orchestrator({
    store,
    userStore: mockUserStore(),
    conversationStore,
    usageStore,
    auditStore,
    gates,
    runner,
    channel,
    runtimeMgr,
    credentialSets,
  });
  return { orch, store, channel, usageStore, auditStore };
}

const msg = { channelId: "test", threadId: "th", requesterId: "u", text: "加个导出 CSV 接口" };

describe("Orchestrator", () => {
  it("代码任务全链 → done", async () => {
    const { orch, store, channel } = setup(true, {
      intro: "正在设计",
      gate: { gateId: "design", summary: "方案A" },
      outro: "完成",
      result: "ok",
    });
    await orch.handleMessage(msg);
    expect(channel.sent.some((m) => m.text.includes("正在设计"))).toBe(true);
    expect((await store.listByStatus("done")).length).toBe(1);
  });

  it("审批驳回 → failed", async () => {
    const { orch, store } = setup(false, {
      intro: "设计",
      gate: { gateId: "design", summary: "方案" },
    });
    await orch.handleMessage(msg);
    expect((await store.listByStatus("failed")).length).toBe(1);
  });

  it("非编码消息也走 agent", async () => {
    const { orch, store } = setup(true, { intro: "你好！", result: "ok" });
    await orch.handleMessage({ ...msg, text: "你好" });
    expect((await store.listByStatus("done")).length).toBe(1);
  });

  it("附件路径会进入 Agent prompt 并要求先读取", async () => {
    let capturedPrompt = "";
    const runner: AgentRunner = {
      run(task, opts, resolver) {
        capturedPrompt = task.prompt;
        return new FakeAgentRunner({ result: "ok" }).run(task, opts, resolver);
      },
    };
    const { orch } = setup(true, {}, runner);
    await orch.handleMessage({
      ...msg,
      files: [{ path: "D:/sessions/conv-1/readme.md", name: "readme.md", type: "markdown" }],
    });

    expect(capturedPrompt).toContain("请先使用 Read 工具读取");
    expect(capturedPrompt).toContain("D:/sessions/conv-1/readme.md");
  });

  it("停止会话会触发 AbortSignal 并将任务标记为 canceled", async () => {
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const runner: AgentRunner = {
      async *run(_task, opts) {
        notifyStarted?.();
        await new Promise<void>((resolve) => {
          opts.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const { orch, store } = setup(true, {}, runner);
    const handling = orch.handleMessage(msg);
    await started;

    expect(orch.cancelConversation("conv-1")).toBe(true);
    await handling;
    expect(await store.listByStatus("canceled")).toHaveLength(1);
  });

  it("runner 出错不崩溃", async () => {
    const channel2 = fakeChannel(true);
    const store2 = new InMemoryTaskStore();
    const throwingRunner: AgentRunner = {
      run() {
        return {
          [Symbol.asyncIterator]() {
            return { next: () => Promise.reject(new Error("GLM 爆了")) };
          },
        };
      },
    };
    const conversationStore2 = mockConversationStore();
    const { mgr: runtimeMgr2, credentialSets: credentialSets2 } =
      makeRuntimeMgr(conversationStore2);
    const orch2 = new Orchestrator({
      store: store2,
      userStore: mockUserStore(),
      conversationStore: conversationStore2,
      gates: new GateRouter(),
      usageStore: new InMemoryUsageStore(),
      auditStore: new InMemoryAuditStore(),
      runner: throwingRunner,
      channel: channel2,
      runtimeMgr: runtimeMgr2,
      credentialSets: credentialSets2,
    });
    await orch2.handleMessage(msg);
    expect(channel2.sent.some((m) => m.text.includes("处理出错"))).toBe(true);
  });

  it("/new 创建新会话", async () => {
    let created = false;
    const cst: ConversationStore = {
      async create() {
        created = true;
        return {
          id: "c-new",
          userId: "u",
          sdkSessionId: "",
          title: "新对话",
          channelId: "test",
          createdAt: "t",
          updatedAt: "t",
          archived: false,
        };
      },
      async get() {
        return undefined;
      },
      async getLatest() {
        return undefined;
      },
      async listByUser() {
        return [];
      },
      async update() {},
    };
    const { mgr: runtimeMgrNew, credentialSets: credentialSetsNew } = makeRuntimeMgr(cst);
    const orch = new Orchestrator({
      store: new InMemoryTaskStore(),
      userStore: mockUserStore(),
      conversationStore: cst,
      gates: new GateRouter(),
      usageStore: new InMemoryUsageStore(),
      auditStore: new InMemoryAuditStore(),
      runner: new FakeAgentRunner({ result: "ok" }),
      channel: fakeChannel(true),
      runtimeMgr: runtimeMgrNew,
      credentialSets: credentialSetsNew,
    });
    await orch.handleMessage({ ...msg, text: "/new" });
    expect(created).toBe(true);
  });

  it("resume 透传到 runner（续接会话 sdkSessionId）", async () => {
    let capturedResume: string | undefined;
    const cst: ConversationStore = {
      async create() {
        return {
          id: "c1",
          userId: "u",
          sdkSessionId: "sdk-existing",
          title: "t",
          channelId: "test",
          createdAt: "t",
          updatedAt: "t",
          archived: false,
        };
      },
      async get() {
        return undefined;
      },
      async getLatest() {
        return {
          id: "c1",
          userId: "u",
          sdkSessionId: "sdk-existing",
          title: "t",
          channelId: "test",
          createdAt: "t",
          updatedAt: "t",
          archived: false,
        };
      },
      async listByUser() {
        return [];
      },
      async update() {},
    };
    // 捕获 runner 收到的 opts.resume
    const capturingRunner: AgentRunner = {
      run(task, opts) {
        capturedResume = opts.resume;
        return new FakeAgentRunner({ result: "ok" }).run(task, opts, async () => ({
          approved: true,
        }));
      },
    };
    const { mgr: runtimeMgrCap, credentialSets: credentialSetsCap } = makeRuntimeMgr(cst);
    const orch = new Orchestrator({
      store: new InMemoryTaskStore(),
      userStore: mockUserStore(),
      conversationStore: cst,
      gates: new GateRouter(),
      runner: capturingRunner,
      channel: fakeChannel(true),
      usageStore: new InMemoryUsageStore(),
      auditStore: new InMemoryAuditStore(),
      runtimeMgr: runtimeMgrCap,
      credentialSets: credentialSetsCap,
    });
    await orch.handleMessage(msg);
    expect(capturedResume).toBe("sdk-existing");
  });

  it("result 带 usage → 落用量记录（字段正确，含 model）", async () => {
    const { orch, usageStore } = setup(true, {
      result: "ok",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 1,
      },
    });
    await orch.handleMessage(msg);
    const records = await usageStore.list();
    expect(records.length).toBe(1);
    expect(records[0]?.totalTokens).toBe(18);
    expect(records[0]?.model).toBe("m");
  });

  it("result 不带 usage → 不落记录", async () => {
    const { orch, usageStore } = setup(true, { result: "ok" });
    await orch.handleMessage(msg);
    expect((await usageStore.list()).length).toBe(0);
  });

  it("error result 带 usage 也落记录（subtype 无关）", async () => {
    const { orch, usageStore } = setup(false, {
      gate: { gateId: "design", summary: "方案" },
      usage: {
        inputTokens: 7,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    });
    await orch.handleMessage(msg);
    expect((await usageStore.list()).length).toBe(1);
  });

  it("审计：捕获 user_message + 各事件，含 conversationId 与单调 seq", async () => {
    const { orch, auditStore } = setup(true, {
      toolCalls: [{ tool: "Read", input: { path: "a" }, toolUseId: "tu1", result: "x" }],
      result: "ok",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    });
    await orch.handleMessage(msg);
    const evs = await auditStore.listByConversation("conv-1");
    const types = evs.map((e) => e.type);
    expect(types[0]).toBe("user_message");
    expect(types).toContain("tool_use");
    expect(types).toContain("tool_result");
    expect(types[types.length - 1]).toBe("result");
    expect(evs.every((e) => e.conversationId === "conv-1")).toBe(true);
    expect(evs.every((e) => e.userId === "u-u")).toBe(true);
    expect(evs.map((e) => e.seq)).toEqual([...evs.keys()].map((n) => n));
  });

  it("审计：result 带轮总耗时与 model", async () => {
    const { orch, auditStore } = setup(true, { result: "ok" });
    await orch.handleMessage(msg);
    const evs = await auditStore.listByConversation("conv-1");
    const result = evs.find((e) => e.type === "result");
    expect(result?.durationMs).toBeGreaterThanOrEqual(0);
    expect(result?.model).toBe("m");
  });

  it("审计：tool_use↔tool_result 配对算工具耗时", async () => {
    const { orch, auditStore } = setup(true, {
      toolCalls: [{ tool: "Read", input: {}, toolUseId: "tu1", result: "x" }],
      result: "ok",
    });
    await orch.handleMessage(msg);
    const evs = await auditStore.listByConversation("conv-1");
    const tr = evs.find((e) => e.type === "tool_result");
    expect(tr?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("审计：落库失败不影响主流程", async () => {
    const throwing: import("../../src/ports/audit-store.js").AuditStore = {
      async record() {
        throw new Error("db 爆了");
      },
      async listByConversation() {
        return [];
      },
      async listConversationSummaries() {
        return [];
      },
    };
    const store = new InMemoryTaskStore();
    const conversationStore = mockConversationStore();
    const { mgr: runtimeMgrAudit, credentialSets: credentialSetsAudit } =
      makeRuntimeMgr(conversationStore);
    const orch = new Orchestrator({
      store,
      userStore: mockUserStore(),
      conversationStore,
      usageStore: new InMemoryUsageStore(),
      auditStore: throwing,
      gates: new GateRouter(),
      runner: new FakeAgentRunner({ result: "ok" }),
      channel: fakeChannel(true),
      runtimeMgr: runtimeMgrAudit,
      credentialSets: credentialSetsAudit,
    });
    await orch.handleMessage(msg);
    expect((await store.listByStatus("done")).length).toBe(1);
  });
});

describe("Orchestrator agent 路径", () => {
  function agentConvStore(agentId: string): ConversationStore {
    const conv: Conversation = {
      id: "conv-agent",
      userId: "u-webu",
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
      async getLatest() {
        return conv;
      },
      async listByUser() {
        return [conv];
      },
      async update() {},
      async createWithAgent(_u, _c, _t, aid) {
        return { ...conv, agentId: aid };
      },
    };
  }

  const agent: import("../../src/domain/agent.js").Agent = {
    id: "a1",
    ownerId: "other",
    name: "A",
    skills: ["s:1"],
    defaultSkill: "s:1",
    tools: { mode: "all", whitelist: [] },
    mcpServers: [],
    credentials: [],
    gitRepositories: [],
    extensionDirectories: [],
    llm: {},
    createdAt: "",
    updatedAt: "",
  };

  function buildOrch(
    convStore: ConversationStore,
    isGranted: boolean,
    script: FakeScript,
    customRunner?: AgentRunner,
  ): { orch: Orchestrator; store: InMemoryTaskStore } {
    const store = new InMemoryTaskStore();
    const agentStore = {
      get: async () => agent,
      listByOwner: async () => [],
      listSharedWith: async () => [],
      create: async () => agent,
      update: async () => agent,
      delete: async () => {},
    } as unknown as import("../../src/ports/agent-store.js").AgentStore;
    const shareStore = {
      isGranted: async () => isGranted,
    } as unknown as import("../../src/ports/agent-share-store.js").AgentShareStore;
    const { mgr: runtimeMgr, credentialSets } = makeRuntimeMgr(convStore);
    const orch = new Orchestrator({
      store,
      userStore: mockUserStore(),
      conversationStore: convStore,
      usageStore: new InMemoryUsageStore(),
      auditStore: new InMemoryAuditStore(),
      gates: new GateRouter(),
      runner: customRunner ?? new FakeAgentRunner(script),
      channel: fakeChannel(true),
      runtimeMgr,
      credentialSets,
      agentStore,
      agentShareStore: shareStore,
    });
    return { orch, store };
  }

  it("无授权访问他人 agent → Forbidden", async () => {
    const { orch } = buildOrch(agentConvStore("a1"), false, { result: "ok" });
    await expect(
      orch.handleMessage({ channelId: "test", threadId: "th", requesterId: "webu", text: "hi" }),
    ).rejects.toThrow();
  });

  it("被授权 → agent 执行成功", async () => {
    const { orch, store } = buildOrch(agentConvStore("a1"), true, { result: "ok" });
    await orch.handleMessage({
      channelId: "test",
      threadId: "th",
      requesterId: "webu",
      text: "hi",
    });
    expect((await store.listByStatus("done")).length).toBe(1);
  });

  it("每次 agent 对话自动追加默认 Skill 指令", async () => {
    let capturedPrompt = "";
    const runner: AgentRunner = {
      run(task, opts, resolver) {
        capturedPrompt = task.prompt;
        return new FakeAgentRunner({ result: "ok" }).run(task, opts, resolver);
      },
    };
    const { orch } = buildOrch(agentConvStore("a1"), true, { result: "ok" }, runner);
    await orch.handleMessage({
      channelId: "test",
      threadId: "th",
      requesterId: "webu",
      text: "查询订单",
    });
    expect(capturedPrompt).toBe("查询订单\n/s:1");
  });
});
