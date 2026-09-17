import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { InMemoryUsageStore } from "../../src/adapters/in-memory-usage-store.js";
import { SqliteCredentialSetStore } from "../../src/adapters/sqlite-credential-set-store.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import type { RunnerEvent, Task } from "../../src/domain/types.js";
import type { UserRole } from "../../src/domain/user.js";
import { createDefaultGates } from "../../src/orchestrator/default-gates.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { RuntimeManager } from "../../src/orchestrator/runtime-manager.js";
import type { AgentRunner, ApprovalResolver, RunOptions } from "../../src/ports/agent-runner.js";
import type { Channel } from "../../src/ports/channel.js";
import type { ConversationStore } from "../../src/ports/conversation-store.js";
import type { SkillInstaller } from "../../src/ports/skill-installer.js";
import type { TranscriptStore } from "../../src/ports/transcript-store.js";
import type { User, UserStore } from "../../src/ports/user-store.js";
import { loadOrGenerateAppSecret } from "../../src/util/app-secret.js";

/** 可控挂起的 runner：每轮在产出 result 前等待测试放行（模拟长任务） */
class GatedRunner implements AgentRunner {
  readonly prompts: string[] = [];
  readonly optsList: RunOptions[] = [];
  private readonly gates: Array<() => void> = [];
  private sessionCounter = 0;

  release(): void {
    const gate = this.gates.shift();
    if (gate) gate();
  }

  async *run(task: Task, opts: RunOptions, _r: ApprovalResolver): AsyncIterable<RunnerEvent> {
    this.prompts.push(task.prompt);
    this.optsList.push(opts);
    this.sessionCounter += 1;
    yield { type: "session_init", taskId: task.id, sessionId: `sdk-${this.sessionCounter}` };
    yield { type: "text", taskId: task.id, text: `回复：${task.prompt}` };
    await new Promise<void>((resolve) => this.gates.push(resolve));
    yield { type: "result", taskId: task.id, subtype: "success", result: `done:${task.prompt}` };
  }
}

/** 顺序出栈脚本 runner：每轮消费队首脚本（chat 兜底等固定编排用） */
class ScriptedRunner implements AgentRunner {
  readonly prompts: string[] = [];
  constructor(private readonly queue: string[]) {}
  async *run(task: Task, _opts: RunOptions, _r: ApprovalResolver): AsyncIterable<RunnerEvent> {
    this.prompts.push(task.prompt);
    const result = this.queue.shift() ?? "done";
    yield { type: "result", taskId: task.id, subtype: "success", result };
  }
}

/** 全状态任务聚合（InMemoryTaskStore 无全量 list，按枚举状态拼装） */
async function allTasks(store: InMemoryTaskStore) {
  const statuses = [
    "created",
    "running",
    "awaiting_approval",
    "awaiting_credentials",
    "done",
    "failed",
    "canceled",
  ] as const;
  return (await Promise.all(statuses.map((s) => store.listByStatus(s)))).flat();
}

function seqChannel(onSend?: (text: string) => Promise<void>) {
  const texts: string[] = [];
  const channel: Channel & { texts: string[] } = {
    id: "test",
    texts,
    onMessage: () => {},
    send: async (_t, m) => {
      texts.push(m.text);
      await onSend?.(m.text);
    },
    requestApproval: async () => ({ approved: true }),
  };
  return channel;
}

function statefulConvStore(agentId = ""): ConversationStore {
  const conv = {
    id: "conv-agent",
    userId: "u-webu",
    sdkSessionId: "",
    title: "排队测试",
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
  const u: User = {
    id: "u-webu",
    name: "webu",
    role: "user" as UserRole,
    homeDir: mkdtempSync(join(tmpdir(), "donger-test-user-")),
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
    async getOrCreateByIdentity() {
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

/** 精简装配；withDispatch=true 时装配空 agentStore（任务分发入口生效） */
function build(
  runner: AgentRunner,
  channel: Channel,
  auditStore = new InMemoryAuditStore(),
  opts: { withDispatch?: boolean; agentId?: string; convStore?: ConversationStore } = {},
): { orch: Orchestrator; store: InMemoryTaskStore; auditStore: InMemoryAuditStore } {
  const store = new InMemoryTaskStore();
  const db = new Database(":memory:");
  const packStore = new SqliteSkillPackStore(db);
  packStore.migrate();
  const credentialSets = new SqliteCredentialSetStore(
    db,
    loadOrGenerateAppSecret(db, "skill_secret_key"),
  );
  credentialSets.migrate();
  const fakeInstaller: SkillInstaller = {
    installFromGit: async () => ({}) as never,
    installFromUpload: async () => ({}) as never,
    installFromPaste: async () => ({}) as never,
    installBuiltin: async () => ({}) as never,
    uninstall: async () => {},
    update: async () => ({}) as never,
  };
  const runtimeMgr = new RuntimeManager({
    transcriptStore: mockTranscriptStore(),
    conversationStore: opts.convStore ?? statefulConvStore(opts.agentId ?? ""),
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
  const orch = new Orchestrator({
    store,
    userStore: mockUserStore(),
    conversationStore: opts.convStore ?? statefulConvStore(opts.agentId ?? ""),
    usageStore: new InMemoryUsageStore(),
    auditStore,
    gates: createDefaultGates(),
    runner,
    channel,
    runtimeMgr,
    credentialSets,
    ...(opts.withDispatch
      ? {
          agentStore: {
            get: async () => undefined,
            listByOwner: async () => [],
            listSharedWith: async () => [],
            listAll: async () => [],
          },
        }
      : {}),
    installer: fakeInstaller,
    skillPackStore: packStore,
  });
  return { orch, store, auditStore };
}

const MSG = (text: string) => ({
  channelId: "test",
  threadId: "th",
  requesterId: "webu",
  text,
});

describe("会话 busy 排队", () => {
  it("busy 时第二条消息入队并在当前任务完成后自动处理", async () => {
    const runner = new GatedRunner();
    const channel = seqChannel();
    const { orch, store } = build(runner, channel);

    const p1 = orch.handleMessage(MSG("任务1"));
    await vi.waitFor(() => expect(runner.prompts).toEqual(["任务1"]));

    // 会话 busy：第二条消息入队并立即返回（提示已排队）
    const convId = await orch.handleMessage(MSG("任务2"));
    expect(convId).toBe("conv-agent");
    expect(channel.texts.some((t) => t.includes("已排队"))).toBe(true);
    expect(runner.prompts).toEqual(["任务1"]); // 未并发执行

    runner.release();
    await p1;
    // 当前任务收尾后，队列中的任务2自动接续
    await vi.waitFor(() => expect(runner.prompts).toEqual(["任务1", "任务2"]));
    runner.release();
    await vi.waitFor(async () => {
      expect((await store.listByStatus("done")).length).toBe(2);
    });
  });

  it("事件先落审计再推送：渠道收到 text 时该事件已在 audit 中", async () => {
    const runner = new GatedRunner();
    // send 时同步检查 audit：时序修复前（先推后落）text 尚未落库，count 只会是 2（user_message+session_init）
    let auditCountAtSend = 0;
    const channel = seqChannel(async () => {
      // 取 send 时刻的快照
      const events = await auditStoreRef.listByConversation("conv-agent");
      auditCountAtSend = events.length;
    });
    const { orch, auditStore: auditStoreRef } = build(runner, channel);

    const p = orch.handleMessage(MSG("任务1"));
    await vi.waitFor(() => expect(runner.prompts).toEqual(["任务1"]));
    runner.release();
    await p;

    // send 时 audit 已含 user_message + session_init + text = 3 条（text 不缺席）
    expect(auditCountAtSend).toBeGreaterThanOrEqual(3);
    const events = await auditStoreRef.listByConversation("conv-agent");
    const types = events.map((e) => e.type);
    expect(types).toContain("text");
    expect(types).not.toContain("llm_input");
  });

  it("排队超上限直接拒绝（不入队不执行）", async () => {
    const runner = new GatedRunner();
    const channel = seqChannel();
    const { orch, store } = build(runner, channel);

    const p1 = orch.handleMessage(MSG("任务1"));
    await vi.waitFor(() => expect(runner.prompts).toEqual(["任务1"]));

    // 再入队 5 条（达到上限）
    for (let i = 2; i <= 6; i++) {
      await orch.handleMessage(MSG(`任务${i}`));
    }
    // 第 7 条被拒绝
    await orch.handleMessage(MSG("任务7"));
    expect(channel.texts.some((t) => t.includes("已达上限"))).toBe(true);
    expect(runner.prompts).toEqual(["任务1"]);

    runner.release();
    await p1;
    // 队列串行接续：逐条放行（每条 run 挂起等待 release）
    for (let i = 2; i <= 6; i++) {
      await vi.waitFor(() => expect(runner.prompts).toContain(`任务${i}`));
      runner.release();
    }
    await vi.waitFor(async () => {
      expect((await store.listByStatus("done")).length).toBe(6); // 1 执行 + 5 排队
    });
  });
});

describe("task flow steps", () => {
  it("chat 兜底：steps 记录 dispatcher→chat，任务归属 builtin-chat", async () => {
    const routing = JSON.stringify({
      agentId: "none",
      taskType: "chat",
      rationale: "闲聊问候",
    });
    const runner = new ScriptedRunner([routing, "你好呀，有什么可以帮你？"]);
    const channel = seqChannel();
    const { orch, store } = build(runner, channel, new InMemoryAuditStore(), {
      withDispatch: true,
    });

    await orch.handleMessage(MSG("在吗"));

    const done = await store.listByStatus("done");
    expect(done).toHaveLength(1);
    expect(done[0]?.agentId).toBe("builtin-chat");
    expect(done[0]?.steps?.map((s) => `${s.role}:${s.status}`)).toEqual([
      "dispatcher:done",
      "chat:done",
    ]);
    expect(done[0]?.steps?.[0]?.summary).toBe("闲聊问候");
    // dispatcher 轮静默：路由 JSON 不进聊天消息流
    expect(runner.prompts).toEqual(["在吗", "在吗"]);
  });

  it("builder 完成自动重派：原任务作为系统消息接续执行", async () => {
    const runner = new GatedRunner();
    const channel = seqChannel();
    const { orch } = build(runner, channel);

    // 模拟 builder 轮期间已登记原任务、且 finish_builder 已触发
    (orch as unknown as { builderOriginalPrompts: Map<string, string> }).builderOriginalPrompts.set(
      "conv-agent",
      "帮我写个天气查询 agent",
    );
    (orch as unknown as { builderFinished: Set<string> }).builderFinished.add("conv-agent");

    // 当前（builder 收尾）消息完成 → finally 检测 finish 标志 → 原任务自动入队重派
    const p = orch.handleMessage(MSG("好的，收尾吧"));
    await vi.waitFor(() => expect(runner.prompts).toContain("好的，收尾吧"));
    runner.release();
    await p;

    await vi.waitFor(() => expect(runner.prompts).toContain("帮我写个天气查询 agent"));
    runner.release();
    await vi.waitFor(async () => {
      expect(runner.prompts).toEqual(["好的，收尾吧", "帮我写个天气查询 agent"]);
    });
  });
});

describe("builder 绑定闲置超时", () => {
  it("绑定超 10 分钟未完成补建 → 自动解绑，消息回归正常分发", async () => {
    const runner = new GatedRunner();
    const channel = seqChannel();
    const { orch } = build(runner, channel, new InMemoryAuditStore(), {
      agentId: "agent-builder",
    });
    const inner = orch as unknown as {
      builderBoundAt: Map<string, number>;
      builderOriginalPrompts: Map<string, string>;
    };

    // 模拟 11 分钟前绑定了 builder
    inner.builderBoundAt.set("conv-agent", Date.now() - 11 * 60 * 1000);
    inner.builderOriginalPrompts.set("conv-agent", "写个天气 agent");

    const p = orch.handleMessage(MSG("明天杭州天气"));
    await vi.waitFor(() => expect(runner.prompts).toEqual(["明天杭州天气"]));
    runner.release();
    await p;

    expect(channel.texts.some((t) => t.includes("超时结束"))).toBe(true);
    expect(inner.builderBoundAt.has("conv-agent")).toBe(false);
    expect(inner.builderOriginalPrompts.has("conv-agent")).toBe(false);
  });
});

/** 多会话 fake：每个消息按 conversationId 路由，支持跨会话并发 */
function multiConvStore(): ConversationStore {
  const cache = new Map<
    string,
    {
      id: string;
      userId: string;
      sdkSessionId: string;
      title: string;
      channelId: string;
      agentId: string;
      createdAt: string;
      updatedAt: string;
      archived: boolean;
    }
  >();
  return {
    async create(_userId, _channelId, title) {
      const id = `conv-${cache.size + 1}`;
      const conv = {
        id,
        userId: "u-webu",
        sdkSessionId: "",
        title: title || id,
        channelId: "test",
        agentId: "",
        createdAt: "t",
        updatedAt: "t",
        archived: false,
      };
      cache.set(id, conv);
      return conv;
    },
    async get(id) {
      return cache.get(id);
    },
    async getLatest() {
      return [...cache.values()].at(-1);
    },
    async listByUser() {
      return [...cache.values()];
    },
    async update(id, patch) {
      const c = cache.get(id);
      if (c) Object.assign(c, patch);
    },
  };
}

/** 可记录淘汰通知与挂起审批的 fake channel（模拟 web-channel 行为） */
function evictableChannel() {
  const texts: string[] = [];
  const pendingApprovals = new Map<string, (r: { approved: boolean; reason?: string }) => void>();
  const evictions: Array<{
    taskId: string;
    conversationId: string;
    taskExcerpt: string;
    startedAt: string;
    pendingSince: string;
    canceledAt: string;
  }> = [];
  const channel: Channel & {
    texts: string[];
    evictions: typeof evictions;
  } = {
    id: "test",
    texts,
    evictions,
    onMessage: () => {},
    send: async (_t, m) => {
      texts.push(m.text);
    },
    requestApproval: (_threadId, card) =>
      new Promise((resolve) => {
        pendingApprovals.set(card.gateId, resolve);
      }),
    cancelPendingApprovals: (conversationId) => {
      for (const [gateId, resolve] of pendingApprovals) {
        resolve({ approved: false, reason: "任务已中断" });
        pendingApprovals.delete(gateId);
        void conversationId;
      }
    },
    pushEvictionNotice: (_conversationId, info) => {
      evictions.push(info);
    },
  };
  return channel;
}

describe("并发满载淘汰最早挂起任务", () => {
  /** 挂审批型 runner：idx === pendAt 的任务触发审批 resolver 并等待（模拟等人工输入） */
  class GatedRunner2 implements AgentRunner {
    readonly prompts: string[] = [];
    private readonly gates: Array<() => void> = [];
    constructor(private readonly pendAt: number) {}
    release(): void {
      this.gates.shift()?.();
    }
    async *run(task: Task, _opts: RunOptions, resolver: ApprovalResolver): AsyncIterable<RunnerEvent> {
      const idx = this.prompts.push(task.prompt) - 1;
      yield { type: "session_init", taskId: task.id, sessionId: `sdk-${idx}` };
      if (idx === this.pendAt) {
        await resolver({
          taskId: task.id,
          gateId: "deploy",
          tool: "Bash",
          toolUseId: `t-${task.id}`,
          input: { command: "deploy prod" },
          summary: "部署审批",
        });
        yield { type: "result", taskId: task.id, subtype: "success", result: `approved:${task.prompt}` };
        return;
      }
      await new Promise<void>((resolve) => this.gates.push(resolve));
      yield { type: "result", taskId: task.id, subtype: "success", result: `done:${task.prompt}` };
    }
  }

  it("满载且无挂起 → 维持拒绝", async () => {
    const orig = (Orchestrator as unknown as { MAX_CONCURRENT_PER_USER: number })
      .MAX_CONCURRENT_PER_USER;
    (Orchestrator as unknown as { MAX_CONCURRENT_PER_USER: number }).MAX_CONCURRENT_PER_USER = 2;
    try {
      const runner = new GatedRunner2(-1);
      const channel = evictableChannel();
      const { orch } = build(runner, channel, new InMemoryAuditStore(), {
        convStore: multiConvStore(),
      });
      const ps = [
        orch.handleMessage({ ...MSG("任务1"), conversationId: "conv-1" }),
        orch.handleMessage({ ...MSG("任务2"), conversationId: "conv-2" }),
      ];
      await vi.waitFor(() => expect(runner.prompts).toEqual(["任务1", "任务2"]));
      await orch.handleMessage({ ...MSG("任务3"), conversationId: "conv-3" });
      expect(channel.texts.some((t) => t.includes("已达上限"))).toBe(true);
      expect(runner.prompts).toEqual(["任务1", "任务2"]);
      expect(channel.evictions).toHaveLength(0);
      for (const p of ps) {
        runner.release();
        await p;
      }
    } finally {
      (Orchestrator as unknown as { MAX_CONCURRENT_PER_USER: number }).MAX_CONCURRENT_PER_USER =
        orig;
    }
  });

  it("满载且有挂起 → 强制结束最早挂起者，新任务成功执行并弹窗告知", async () => {
    const orig = (Orchestrator as unknown as { MAX_CONCURRENT_PER_USER: number })
      .MAX_CONCURRENT_PER_USER;
    (Orchestrator as unknown as { MAX_CONCURRENT_PER_USER: number }).MAX_CONCURRENT_PER_USER = 2;
    try {
      const runner = new GatedRunner2(0); // 任务1 挂审批
      const channel = evictableChannel();
      const { orch, store } = build(runner, channel, new InMemoryAuditStore(), {
        convStore: multiConvStore(),
      });
      const p1 = orch.handleMessage({ ...MSG("任务1-等审批"), conversationId: "conv-1" });
      const p2 = orch.handleMessage({ ...MSG("任务2-执行中"), conversationId: "conv-2" });
      await vi.waitFor(async () =>
        expect((await allTasks(store)).filter((t) => t.status === "awaiting_approval").length).toBe(1),
      );

      // 第 3 个任务：淘汰最早挂起的任务1（而非活跃执行中的任务2）
      const p3 = orch.handleMessage({ ...MSG("任务3-新任务"), conversationId: "conv-3" });
      await vi.waitFor(() => expect(runner.prompts).toContain("任务3-新任务"));

      // 被淘汰任务收口为 canceled，审批挂起被解开
      await vi.waitFor(async () => {
        expect((await allTasks(store)).find((t) => t.prompt.includes("任务1"))?.status).toBe("canceled");
      });
      // 新任务的会话收到弹窗事件：含任务摘要与三个时间
      expect(channel.evictions).toHaveLength(1);
      expect(channel.evictions[0].conversationId).toBe("conv-1");
      expect(channel.evictions[0].taskExcerpt).toContain("任务1-等审批");
      expect(channel.evictions[0].startedAt).toBeTruthy();
      expect(channel.evictions[0].pendingSince).toBeTruthy();
      expect(channel.evictions[0].canceledAt).toBeTruthy();
      // 渠道文本兜底：说明情况 + 详情
      expect(channel.texts.some((t) => t.includes("并发已达上限") && t.includes("任务1-等审批"))).toBe(
        true,
      );
      // 未误伤活跃执行中的任务2
      expect((await allTasks(store)).find((t) => t.prompt.includes("任务2"))?.status).not.toBe(
        "canceled",
      );

      // 任务2/任务3 各占一个长任务闸，逐个放行
      runner.release();
      await p2;
      runner.release();
      await p3;
      void p1;
    } finally {
      (Orchestrator as unknown as { MAX_CONCURRENT_PER_USER: number }).MAX_CONCURRENT_PER_USER =
        orig;
    }
  });
});
