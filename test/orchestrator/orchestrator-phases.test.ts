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
import type { Agent } from "../../src/domain/agent.js";
import type { Conversation } from "../../src/domain/conversation.js";
import type { SkillPack } from "../../src/domain/skill-pack.js";
import type { ApprovalCard, RunnerEvent, Task } from "../../src/domain/types.js";
import type { User, UserRole } from "../../src/domain/user.js";
import { createDefaultGates } from "../../src/orchestrator/default-gates.js";
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

/** 审批决议序列通道：记录卡片与发送文本 */
function seqChannel() {
  const cards: ApprovalCard[] = [];
  const texts: string[] = [];
  const channel: Channel & { cards: ApprovalCard[]; texts: string[] } = {
    id: "test",
    cards,
    texts,
    onMessage: () => {},
    send: async (_t, m) => {
      texts.push(m.text);
    },
    requestApproval: async (_t, c) => {
      cards.push(c);
      return { approved: true };
    },
  };
  return channel;
}

/** 有状态会话存储：sdkSessionId/agentId 经 update 持久化（验证阶段间 resume 链与 builder 绑定）；conv 供断言 */
function statefulConvStore(
  agentId: string,
  title = "agent 会话",
): ConversationStore & { conv: Conversation } {
  const conv: Conversation = {
    id: "conv-agent",
    userId: "u-webu",
    sdkSessionId: "",
    title,
    channelId: "test",
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
    async updateSidebarPrefs() {},
    async setPasswordCredential() {},
    async getPasswordCredential() {
      return undefined;
    },
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

function makeRuntimeMgr(conversationStore: ConversationStore): {
  mgr: RuntimeManager;
  credentialSets: SqliteCredentialSetStore;
  packStore: SqliteSkillPackStore;
  installer: SkillInstaller;
} {
  const db = new Database(":memory:");
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
    credentialSets,
    installer: fakeInstaller,
    builtinSkillsDir: "",
  });
  return { mgr, credentialSets, packStore, installer: fakeInstaller };
}

function build(
  runner: AgentRunner,
  channel: Channel,
  convStore: ConversationStore,
  skills: string[] = ["x-execute"],
  agentOverrides: Partial<Agent> = {},
): { orch: Orchestrator; store: InMemoryTaskStore } {
  const store = new InMemoryTaskStore();
  const agent: Agent = {
    id: "a1",
    ownerId: "u-webu",
    name: "A",
    skills,
    tools: { mode: "all", whitelist: [] },
    mcpServers: [],
    credentials: [],
    gitRepositories: [],
    gitAllowShellGit: false,
    extensionDirectories: [],
    version: 1,
    createdAt: "",
    updatedAt: "",
    ...agentOverrides,
  };
  const agentStore = {
    get: async () => ({ ...agent, ...agentOverrides }),
    listByOwner: async () => [],
    listSharedWith: async () => [],
    listAll: async () => [],
    create: async () => agent,
    update: async () => agent,
    delete: async () => {},
  } as unknown as import("../../src/ports/agent-store.js").AgentStore;
  const { mgr: runtimeMgr, credentialSets, packStore, installer } = makeRuntimeMgr(convStore);
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
    credentialSets,
    agentStore,
    installer,
    skillPackStore: packStore,
  });
  return { orch, store };
}

const MSG = { channelId: "test", threadId: "th", requesterId: "webu", text: "修复导出乱码" };

describe("agent 任务单执行轮生命周期", () => {
  it("显式 agent（会话绑定）→单轮 execute→done，无审批卡", async () => {
    const runner = new ScriptedRunner([{ result: "回答完成" }]);
    const channel = seqChannel();
    const { orch, store } = build(runner, channel, statefulConvStore("a1"));

    await orch.handleMessage(MSG);

    expect(await store.listByStatus("done")).toHaveLength(1);
    expect(channel.cards).toHaveLength(0);
    expect(runner.prompts).toHaveLength(1);
  });

  it("执行轮引擎 error 收尾 → failed 且会话补发失败消息（收尾必达）", async () => {
    // 2026-10-29 回复无声中断诊断：runPhases 失败分支原先只 pushResult（UI 标记，
    // 钉钉 no-op 不落消息），用户零感知只能手动重发试探
    const runner: AgentRunner = {
      async *run(task): AsyncIterable<RunnerEvent> {
        yield { type: "session_init", taskId: task.id, sessionId: "sdk-1" };
        yield { type: "text", taskId: task.id, text: "半句话：" };
        yield { type: "result", taskId: task.id, subtype: "error", error: "引擎流提前结束" };
      },
    };
    const channel = seqChannel();
    const { orch, store } = build(runner, channel, statefulConvStore("a1"));

    await orch.handleMessage(MSG);

    expect(await store.listByStatus("failed")).toHaveLength(1);
    expect(
      channel.texts.some((t) => t.includes("处理出错") && t.includes("引擎流提前结束")),
    ).toBe(true);
  });

  it("未绑定会话消息 → 显式失败提示且不执行（内置路由链退役）", async () => {
    const runner = new ScriptedRunner([{ result: "不应执行" }]);
    const channel = seqChannel();
    const { orch, store } = build(runner, channel, statefulConvStore(""));

    await orch.handleMessage(MSG);

    expect(channel.texts.some((t) => t.includes("未绑定智能体"))).toBe(true);
    expect(runner.prompts).toEqual([]);
    expect(await store.listByStatus("done")).toHaveLength(0);
  });

  it("已退役内置智能体会话 → 报「已下架」（不执行）", async () => {
    const runner = new ScriptedRunner([{ result: "不应执行" }]);
    const { orch } = build(runner, seqChannel(), statefulConvStore("builtin-auditor"));

    await expect(orch.handleMessage(MSG)).rejects.toThrow("已下架");
    expect(runner.prompts).toEqual([]);
  });

  it("direct 绑定他人未分享 agent → rejects（AGENT_FORBIDDEN 语义不变）", async () => {
    const runner = new ScriptedRunner([{ result: "不应执行" }]);
    const { orch } = build(runner, seqChannel(), statefulConvStore("a1"), ["x-execute"], {
      ownerId: "someone-else",
    });

    await expect(orch.handleMessage(MSG)).rejects.toThrow("无权使用该智能体");
    expect(runner.prompts).toEqual([]);
  });

  it("audit 工具白名单声明式挂载：声明 mcp__donger-audit 即注入，mode=all 不注入", async () => {
    // 2026-11-04 内置退役：donger-audit 挂载从「三个内置 id 特判」改为白名单声明式，
    // 库内 agent（如 L2 自动修复工程师）声明的工具面从此真实可用
    const runner = new ScriptedRunner([{ result: "分析完成" }]);
    const channel = seqChannel();
    const { orch, store } = build(runner, channel, statefulConvStore("a1"), ["x-execute"], {
      tools: { mode: "whitelist", whitelist: ["mcp__donger-audit"] },
    });
    await orch.handleMessage(MSG);
    expect(await store.listByStatus("done")).toHaveLength(1);
    expect(runner.optsList[0]?.auditTools?.name).toBe("donger-audit");
    expect(runner.optsList[0]?.allowedTools).toEqual(["mcp__donger-audit"]);

    const runner2 = new ScriptedRunner([{ result: "完成" }]);
    const { orch: orch2 } = build(runner2, seqChannel(), statefulConvStore("a1"), ["x-execute"], {
      tools: { mode: "all", whitelist: [] },
    });
    await orch2.handleMessage(MSG);
    expect(runner2.optsList[0]?.auditTools).toBeUndefined();
  });
});
