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
function statefulConvStore(agentId: string): ConversationStore & { conv: Conversation } {
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

const ROUTING_JSON = '{"agentId":"a1","taskType":"dev","rationale":"前端任务"}';

function visibleAgent(): Agent {
  return {
    id: "a1",
    ownerId: "u-webu",
    name: "A",
    description: "演示智能体",
    skills: [],
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
}

function build(
  runner: AgentRunner,
  channel: Channel,
  convStore: ConversationStore,
  skills: string[] = ["x-execute"],
  agentOverrides: Partial<Agent> = {},
  /** listByOwner 返回值：模拟 dispatcher 登记表的可见 agent 集合 */
  visible: Agent[] = [],
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
    listByOwner: async () => visible,
    listSharedWith: async () => [],
    listAll: async () => visible,
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
  it("dispatch 路由 → 单执行轮 → done，无审批卡；prompt 保持原文", async () => {
    const runner = new ScriptedRunner([
      { result: ROUTING_JSON }, // dispatcher
      { result: "执行完成" }, // execute
    ]);
    const channel = seqChannel();
    const { orch, store } = build(runner, channel, statefulConvStore(""));

    await orch.handleMessage(MSG);

    const done = await store.listByStatus("done");
    expect(done).toHaveLength(1);
    expect(done[0]?.agentId).toBe("a1");
    expect(done[0]?.routingRationale).toBe("前端任务");
    // 无阶段门：整个任务只有 dispatcher + 执行两轮，不弹审批卡
    expect(channel.cards).toHaveLength(0);
    expect(runner.prompts).toEqual([MSG.text, MSG.text]);
    // dispatcher 轮走统一管道但不接续会话（noResume）；执行轮为会话首轮（dispatcher 的
    // sessionId 不回写），其自身 sdkSessionId 轮末回写供后续消息接续
    expect(runner.optsList[0]?.resume).toBeUndefined();
    expect(runner.optsList[0]?.sessionStore).toBeUndefined();
    expect(runner.optsList[1]?.resume).toBeUndefined();
    expect(runner.optsList[1]?.sessionStore).toBeDefined();
  });

  it("dispatcher 登记表读时渲染：提示词只含当前用户可见的 agent", async () => {
    // 可见集合含自有 agent a1：登记表进入 dispatcher 系统提示
    const runner = new ScriptedRunner([{ result: ROUTING_JSON }, { result: "执行完成" }]);
    const channel = seqChannel();
    const { orch } = build(runner, channel, statefulConvStore(""), ["x-execute"], {}, [
      visibleAgent(),
    ]);
    await orch.handleMessage(MSG);
    expect(runner.optsList[0]?.systemPromptAppend).toContain("a1");
    expect(runner.optsList[0]?.systemPromptAppend).toContain("## 场景词表");

    // 可见集合为空：登记表空表提示（非 chat 类任务转 builder 兜底）
    const runner2 = new ScriptedRunner([
      { result: '{"agentId":"none","taskType":"dev","rationale":"缺能力"}' },
    ]);
    const { orch: orch2 } = build(runner2, seqChannel(), statefulConvStore(""));
    await orch2.handleMessage(MSG);
    expect(runner2.optsList[0]?.systemPromptAppend).toContain("当前暂无可用智能体");
  });

  it("显式 agent（会话绑定）→单轮 execute→done，无审批卡", async () => {
    const runner = new ScriptedRunner([{ result: "回答完成" }]);
    const channel = seqChannel();
    const { orch, store } = build(runner, channel, statefulConvStore("a1"));

    await orch.handleMessage(MSG);

    expect(await store.listByStatus("done")).toHaveLength(1);
    expect(channel.cards).toHaveLength(0);
    expect(runner.prompts).toHaveLength(1);
  });

  it("builtin-assist 会话：短路解析内置智能体，单轮执行且系统提示注入", async () => {
    const runner = new ScriptedRunner([{ result: "已创建 agent" }]);
    const channel = seqChannel();
    const { orch, store } = build(runner, channel, statefulConvStore("builtin-assist"));

    await orch.handleMessage(MSG);

    expect(await store.listByStatus("done")).toHaveLength(1);
    expect(runner.optsList[0]?.systemPromptAppend).toContain("创作助手");
    expect(channel.cards).toHaveLength(0);
  });

  it("assist 会话注入 platformTools（in-process MCP server）", async () => {
    const runner = new ScriptedRunner([{ result: "完成" }]);
    const channel = seqChannel();
    const { orch, store } = build(runner, channel, statefulConvStore("builtin-assist"));

    await orch.handleMessage(MSG);

    expect(await store.listByStatus("done")).toHaveLength(1);
    expect(runner.optsList[0]?.platformTools?.name).toBe("donger-platform");
    expect(runner.optsList[0]?.platformTools?.type).toBe("sdk");
  });

  it("dispatch none 回复含「AI 生成助手」引导", async () => {
    const runner = new ScriptedRunner([
      { result: '{"agentId":"none","taskType":"dev","rationale":"缺能力"}' },
      { result: "已补建" }, // agent-builder 首轮
    ]);
    const channel = seqChannel();
    const { orch } = build(runner, channel, statefulConvStore(""));
    await orch.handleMessage(MSG);
    expect(channel.texts.join("\n")).toContain("Agent Builder");
  });

  it("dispatch none → 转入 agent-builder 兜底（不失败、绑定会话、注入缺口与平台工具）", async () => {
    const runner = new ScriptedRunner([
      { result: '{"agentId":"none","taskType":"dev","rationale":"缺能力"}' },
      { result: "已补建" },
    ]);
    const channel = seqChannel();
    const convStore = statefulConvStore("");
    const { orch, store } = build(runner, channel, convStore);

    await orch.handleMessage(MSG);

    // 任务不失败，绑定 agent-builder 正常走完
    expect(await store.listByStatus("failed")).toHaveLength(0);
    const done = await store.listByStatus("done");
    expect(done).toHaveLength(1);
    expect(done[0]?.agentId).toBe("agent-builder");
    expect(done[0]?.routingRationale).toBe("缺能力");
    // 任务记录保持用户原文（引导词只注入执行轮，不回写任务）
    expect(done[0]?.prompt).toBe(MSG.text);
    // 会话绑定持久化（真实 SqliteConversationStore 行为），标题不被引导词污染
    expect(convStore.conv.agentId).toBe("agent-builder");
    expect(convStore.conv.title).toBe(MSG.text.slice(0, 30));
    // 首轮 prompt 含缺口分析 + 原始任务
    expect(runner.prompts[1]).toContain("缺能力");
    expect(runner.prompts[1]).toContain("修复导出乱码");
    // 平台工具注入（write_skill / create_agent / finish_builder 可用）
    expect(runner.optsList[1]?.platformTools?.name).toBe("donger-platform");
    // 转入提示
    expect(channel.texts.join("\n")).toContain("Agent Builder");
  });

  it("agent-builder 会话绑定后续消息直连（不再过 dispatcher）", async () => {
    const runner = new ScriptedRunner([
      { result: '{"agentId":"none","taskType":"dev","rationale":"缺能力"}' },
      { result: "已补建" },
      { result: "补充说明" }, // 同会话第二条消息
    ]);
    const channel = seqChannel();
    const { orch, store } = build(runner, channel, statefulConvStore(""));

    await orch.handleMessage(MSG);
    await orch.handleMessage({ ...MSG, text: "顺便加个验收 skill" });

    // 轮次：dispatcher → builder 首轮 → builder 第二轮（无第二次 dispatch）
    expect(runner.prompts).toHaveLength(3);
    expect(runner.prompts[2]).toContain("顺便加个验收 skill");
    expect(await store.listByStatus("done")).toHaveLength(2);
  });

  it("agent-builder 会话：短路解析内置智能体且注入 platformTools", async () => {
    const runner = new ScriptedRunner([{ result: "已补建" }]);
    const channel = seqChannel();
    const { orch, store } = build(runner, channel, statefulConvStore("agent-builder"));

    await orch.handleMessage(MSG);

    expect(await store.listByStatus("done")).toHaveLength(1);
    expect(runner.optsList[0]?.platformTools?.name).toBe("donger-platform");
    expect(runner.optsList[0]?.systemPromptAppend).toContain("构建助手");
  });
});

describe("dispatch 权限降级", () => {
  it("路由命中但当前用户无权使用 → 可行动提示 + task failed（不硬抛裸错误）", async () => {
    const runner = new ScriptedRunner([{ result: ROUTING_JSON }]);
    const channel = seqChannel();
    const { orch, store } = build(
      runner,
      channel,
      statefulConvStore(""),
      ["x-execute"],
      { ownerId: "someone-else" }, // dispatcher 命中 a1，但 a1 属他人且未分享
    );

    await orch.handleMessage(MSG);

    const failed = await store.listByStatus("failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toContain("无权");
    expect(channel.texts.some((t) => t.includes("无权使用它"))).toBe(true);
    // 失败后不再进入执行轮（runner 只消费了 dispatcher 路由这一条）
    expect(runner.prompts).toEqual([MSG.text]);
  });
});

describe("内置智能体扩充（技能工坊/会话审计师/平台进化官）", () => {
  function adminUserStore(): UserStore {
    const base = mockUserStore();
    const dir = mkdtempSync(join(tmpdir(), "donger-test-admin-"));
    const admin: User = {
      id: "u-admin",
      name: "admin",
      role: "admin" as UserRole,
      homeDir: dir,
      createdAt: "t",
      updatedAt: "t",
    };
    return {
      ...base,
      async get(id) {
        return id === "u-admin" ? admin : undefined;
      },
      async getOrCreateByIdentity(_p, externalId, _name) {
        return externalId === "u-admin" ? admin : undefined;
      },
    } as unknown as UserStore;
  }

  function buildWithUserStore(
    userStore: UserStore,
    convStore: ConversationStore,
    runner: AgentRunner,
  ): { orch: Orchestrator; store: InMemoryTaskStore } {
    const store = new InMemoryTaskStore();
    const { mgr: runtimeMgr, credentialSets, packStore, installer } = makeRuntimeMgr(convStore);
    const orch = new Orchestrator({
      store,
      userStore,
      conversationStore: convStore,
      usageStore: new InMemoryUsageStore(),
      auditStore: new InMemoryAuditStore(),
      gates: createDefaultGates(),
      runner,
      channel: seqChannel(),
      runtimeMgr,
      credentialSets,
      installer,
      skillPackStore: packStore,
      agentStore: {
        get: async () => undefined,
        listByOwner: async () => [],
        listSharedWith: async () => [],
        listAll: async () => [],
      } as unknown as import("../../src/ports/agent-store.js").AgentStore,
    });
    return { orch, store };
  }

  it("平台进化官：非管理员直接拒绝（AGENT_FORBIDDEN）", async () => {
    const runner = new ScriptedRunner([{ result: "ok" }]);
    const { orch } = build(runner, seqChannel(), statefulConvStore("builtin-self-improver"));
    // direct 路径的无权语义与 DB agent 一致：resolveAgentForUse 抛 ForbiddenError 向上传播
    await expect(orch.handleMessage(MSG)).rejects.toThrow("仅管理员可用");
    expect(runner.prompts).toEqual([]);
  });

  it("平台进化官：管理员可用，注入 donger-audit，系统提示含红线", async () => {
    const runner = new ScriptedRunner([{ result: "已产出评估" }]);
    const { orch, store } = buildWithUserStore(
      adminUserStore(),
      statefulConvStore("builtin-self-improver"),
      runner,
    );
    await orch.handleMessage({ ...MSG, requesterId: "u-admin" });
    expect(await store.listByStatus("done")).toHaveLength(1);
    expect(runner.optsList[0]?.auditTools?.name).toBe("donger-audit");
    expect(runner.optsList[0]?.systemPromptAppend).toContain("安全红线");
  });

  it("技能工坊：注入 platformTools 与 donger-audit，挂载双技能", async () => {
    const runner = new ScriptedRunner([{ result: "技能已写入" }]);
    const { orch, store } = build(runner, seqChannel(), statefulConvStore("builtin-skill-forge"));
    await orch.handleMessage(MSG);
    expect(await store.listByStatus("done")).toHaveLength(1);
    expect(runner.optsList[0]?.platformTools?.name).toBe("donger-platform");
    expect(runner.optsList[0]?.auditTools?.name).toBe("donger-audit");
    expect(runner.optsList[0]?.skills).toEqual(["skill-create", "skill-upgrade"]);
  });

  it("会话审计师：注入 donger-audit，工具白名单仅 donger-audit", async () => {
    const runner = new ScriptedRunner([{ result: "分析完成" }]);
    const { orch, store } = build(runner, seqChannel(), statefulConvStore("builtin-auditor"));
    await orch.handleMessage(MSG);
    expect(await store.listByStatus("done")).toHaveLength(1);
    expect(runner.optsList[0]?.auditTools?.name).toBe("donger-audit");
    expect(runner.optsList[0]?.allowedTools).toEqual(["mcp__donger-audit"]);
  });
});
