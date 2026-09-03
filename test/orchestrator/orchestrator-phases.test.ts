import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { FakeAgentRunner, type FakeScript } from "../../src/adapters/fake-agent-runner.js";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { InMemoryUsageStore } from "../../src/adapters/in-memory-usage-store.js";
import { SqliteCredentialStore } from "../../src/adapters/sqlite-credential-store.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import type { Agent } from "../../src/domain/agent.js";
import type { Conversation } from "../../src/domain/conversation.js";
import type { SkillPack } from "../../src/domain/skill-pack.js";
import type { ApprovalCard, RunnerEvent, Task } from "../../src/domain/types.js";
import type { User, UserRole } from "../../src/domain/user.js";
import { createDefaultGates } from "../../src/orchestrator/default-gates.js";
import { ensureDispatcherKb } from "../../src/orchestrator/dispatch-kb.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { RuntimeManager } from "../../src/orchestrator/runtime-manager.js";
import type { AgentRunner, ApprovalResolver, RunOptions } from "../../src/ports/agent-runner.js";
import type { Channel } from "../../src/ports/channel.js";
import type { ConversationStore } from "../../src/ports/conversation-store.js";
import type { SkillInstaller } from "../../src/ports/skill-installer.js";
import type { TranscriptStore } from "../../src/ports/transcript-store.js";
import type { UserStore } from "../../src/ports/user-store.js";
import { loadOrGenerateAppSecret } from "../../src/util/app-secret.js";

/** 顺序出栈脚本的 runner：每次 run() 消费队首脚本；记录每轮 prompt/opts 供断言 */
class ScriptedRunner implements AgentRunner {
  readonly prompts: string[] = [];
  readonly optsList: RunOptions[] = [];
  private sessionCounter = 0;
  constructor(private readonly queue: FakeScript[]) {}

  async *run(
    task: Task,
    opts: RunOptions,
    approvalResolver: ApprovalResolver,
  ): AsyncIterable<RunnerEvent> {
    this.prompts.push(task.prompt);
    this.optsList.push(opts);
    const script = this.queue.shift() ?? { result: "done" };
    // 每轮产出独立 session_init，模拟 SDK 会话推进
    this.sessionCounter += 1;
    yield { type: "session_init", taskId: task.id, sessionId: `sdk-${this.sessionCounter}` };
    yield* new FakeAgentRunner(script).run(task, opts, approvalResolver);
  }
}

/** 审批决议序列通道：按序消费 approvals；记录卡片 */
function seqChannel(approvals: Array<{ approved: boolean; reason?: string }>) {
  const cards: ApprovalCard[] = [];
  const channel: Channel & { cards: ApprovalCard[] } = {
    id: "test",
    cards,
    onMessage: () => {},
    send: async () => {},
    requestApproval: async (_t, c) => {
      cards.push(c);
      return approvals.shift() ?? { approved: true };
    },
  };
  return channel;
}

/** 有状态会话存储：sdkSessionId 经 update 持久化（验证阶段间 resume 链） */
function statefulConvStore(agentId: string): ConversationStore {
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
    async update(_id, patch) {
      Object.assign(conv, patch);
    },
  };
}

function mockUserStore(): UserStore {
  const dir = mkdtempSync(join(tmpdir(), "donger-test-user-"));
  const u: User = {
    id: "u-webu",
    name: "webu",
    role: "user" as UserRole,
    homeDir: dir,
    createdAt: "t",
    updatedAt: "t",
  };
  return {
    async get(id) {
      return id === u.id ? u : undefined;
    },
    async list() {
      return [u];
    },
    async getOrCreateByIdentity(_p, _externalId, _name) {
      return u;
    },
    async isAdminByExternalId() {
      return false;
    },
    async findByIdentity() {
      return undefined;
    },
    async addIdentity() {},
    async getIdentities() {
      return [];
    },
    async updateProfile() {},
    async updateRole() {},
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
    async listSubkeys() {
      return [];
    },
    async delete() {},
  };
}

function makeRuntimeMgr(conversationStore: ConversationStore): {
  mgr: RuntimeManager;
  credentialStore: SqliteCredentialStore;
} {
  const db = new Database(":memory:");
  const packStore = new SqliteSkillPackStore(db);
  packStore.migrate();
  const credentialStore = new SqliteCredentialStore(
    db,
    loadOrGenerateAppSecret(db, "skill_secret_key"),
  );
  credentialStore.migrate();
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
      defaultSystemPromptAppend: "测试",
      agentLlmPresets: [],
    },
    skillPackStore: packStore,
    credentialStore,
    installer: fakeInstaller,
    builtinSkillsDir: "",
  });
  return { mgr, credentialStore };
}

const ROUTING_JSON =
  '{"agentId":"a1","requiresDesign":true,"taskType":"dev","rationale":"前端任务"}';

function build(
  runner: AgentRunner,
  channel: Channel,
  convStore: ConversationStore,
  skills: string[] = ["x-design", "x-execute", "x-accept"],
): { orch: Orchestrator; store: InMemoryTaskStore } {
  const store = new InMemoryTaskStore();
  const agent: Agent = {
    id: "a1",
    ownerId: "u-webu",
    name: "A",
    skills,
    tools: { mode: "all", whitelist: [] },
    mcpServers: [],
    llm: {},
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
  const { mgr: runtimeMgr, credentialStore } = makeRuntimeMgr(convStore);
  const kbDir = mkdtempSync(join(tmpdir(), "donger-kb-"));
  ensureDispatcherKb(kbDir);
  const orch = new Orchestrator({
    store,
    userStore: mockUserStore(),
    conversationStore: convStore,
    usageStore: new InMemoryUsageStore(),
    auditStore: new InMemoryAuditStore(),
    gates: createDefaultGates(),
    runner,
    channel,
    runtimeMgr,
    credentialStore,
    agentStore,
    kbDir,
  });
  return { orch, store };
}

const MSG = { channelId: "test", threadId: "th", requesterId: "webu", text: "修复导出乱码" };

describe("三段式生命周期", () => {
  it("dispatch→design→方案门过→execute→accept→验收门过→done", async () => {
    const runner = new ScriptedRunner([
      { result: ROUTING_JSON }, // dispatcher
      { result: "方案：三步走" }, // design
      { result: "执行完成" }, // execute
      { result: "自验通过" }, // accept
    ]);
    const channel = seqChannel([{ approved: true }, { approved: true }]);
    const { orch, store } = build(runner, channel, statefulConvStore(""));

    await orch.handleMessage(MSG);

    const done = await store.listByStatus("done");
    expect(done).toHaveLength(1);
    expect(done[0]?.requiresDesign).toBe(true);
    expect(done[0]?.agentId).toBe("a1");
    expect(channel.cards.map((c) => c.gateId)).toEqual(["design", "acceptance"]);
    // 阶段 prompt 关键词
    expect(runner.prompts[1]).toContain("实施方案");
    expect(runner.prompts[2]).toContain("方案已确认");
    expect(runner.prompts[3]).toContain("自验");
    // 阶段间 resume 链：execute 轮 resume = design 轮 sessionId
    expect(runner.optsList[2]?.resume).toBe("sdk-2");
    expect(runner.optsList[3]?.resume).toBe("sdk-3");
  });

  it("方案驳回→重设计（带原因）→通过→…→done（rejectionCount 不增）", async () => {
    const runner = new ScriptedRunner([
      { result: ROUTING_JSON },
      { result: "方案 v1" },
      { result: "方案 v2" },
      { result: "执行完成" },
      { result: "自验通过" },
    ]);
    const channel = seqChannel([
      { approved: false, reason: "漏了编码转换" },
      { approved: true },
      { approved: true },
    ]);
    const { orch, store } = build(runner, channel, statefulConvStore(""));

    await orch.handleMessage(MSG);

    expect(await store.listByStatus("done")).toHaveLength(1);
    expect(runner.prompts[2]).toContain("方案被驳回");
    expect(runner.prompts[2]).toContain("漏了编码转换");
    expect(channel.cards[0]?.gateId).toBe("design");
    const done = (await store.listByStatus("done"))[0];
    expect(done?.rejectionCount ?? 0).toBe(0); // 方案驳回不计验收驳回
  });

  it("验收驳回→rejectionCount=1→重执行→再验→done", async () => {
    const runner = new ScriptedRunner([
      { result: ROUTING_JSON },
      { result: "方案" },
      { result: "执行 v1" },
      { result: "自验 v1" },
      { result: "执行 v2" },
      { result: "自验 v2" },
    ]);
    const channel = seqChannel([
      { approved: true },
      { approved: false, reason: "还有乱码用例" },
      { approved: true },
    ]);
    const { orch, store } = build(runner, channel, statefulConvStore(""));

    await orch.handleMessage(MSG);

    const done = await store.listByStatus("done");
    expect(done).toHaveLength(1);
    expect(done[0]?.rejectionCount).toBe(1);
    expect(runner.prompts[4]).toContain("验收被驳回");
    expect(runner.prompts[4]).toContain("还有乱码用例");
  });

  it("显式 agent（无 dispatch、无 accept skill）→单轮 execute→done，无审批卡", async () => {
    const runner = new ScriptedRunner([{ result: "回答完成" }]);
    const channel = seqChannel([]);
    const { orch, store } = build(runner, channel, statefulConvStore("a1"), ["x-execute"]);

    await orch.handleMessage(MSG);

    expect(await store.listByStatus("done")).toHaveLength(1);
    expect(channel.cards).toHaveLength(0);
    expect(runner.prompts).toHaveLength(1);
  });
});
