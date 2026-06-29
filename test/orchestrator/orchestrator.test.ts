import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentRunner, type FakeScript } from "../../src/adapters/fake-agent-runner.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import type { Conversation } from "../../src/domain/conversation.js";
import { GateRouter } from "../../src/domain/gate-router.js";
import { Planner } from "../../src/domain/planner.js";
import type { ApprovalCard, OutgoingMessage } from "../../src/domain/types.js";
import type { User, UserRole } from "../../src/domain/user.js";
import { Orchestrator, type OrchestratorRunOpts } from "../../src/orchestrator/orchestrator.js";
import type { AgentRunner, RunOptions } from "../../src/ports/agent-runner.js";
import type { Channel } from "../../src/ports/channel.js";
import type { ConversationStore } from "../../src/ports/conversation-store.js";
import type { UserStore } from "../../src/ports/user-store.js";

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
  return {
    async getOrCreate(staffId, name) {
      let u = users.get(staffId);
      if (!u) {
        u = {
          id: `u-${staffId}`,
          staffId,
          name,
          role: "user" as UserRole,
          homeDir: dir,
          createdAt: "t",
          updatedAt: "t",
        };
        users.set(staffId, u);
      }
      return u;
    },
    async get() {
      return undefined;
    },
    async getByStaffId(staffId) {
      return users.get(staffId);
    },
    async updateRole() {},
    async list() {
      return [...users.values()];
    },
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

function setup(approve: boolean, script: FakeScript) {
  const store = new InMemoryTaskStore();
  const channel = fakeChannel(approve);
  const runner = new FakeAgentRunner(script);
  const gates = new GateRouter();
  gates.describe({ id: "design", description: "方案审批" });
  const orch = new Orchestrator({
    store,
    userStore: mockUserStore(),
    conversationStore: mockConversationStore(),
    planner: new Planner(),
    gates,
    runner,
    channel,
    runOptsFor: async (
      _task,
      plan,
      _user: User,
      _opts: OrchestratorRunOpts,
    ): Promise<RunOptions> => ({
      cwd: ".",
      skills: plan.skills,
      llm: { model: "m", baseUrl: "u", authToken: "t" },
    }),
  });
  return { orch, store, channel };
}

const msg = { channelId: "test", threadId: "th", requesterId: "u", text: "加个导出 CSV 接口" };

describe("Orchestrator", () => {
  it("收到即确认 → 全链 → done", async () => {
    const { orch, store, channel } = setup(true, {
      intro: "正在设计",
      gate: { gateId: "design", summary: "方案A" },
      outro: "完成",
      result: "ok",
    });
    await orch.handleMessage(msg);
    expect(channel.sent.some((m) => m.text.includes("收到"))).toBe(true);
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

  it("runner 出错不崩溃", async () => {
    const channel2 = fakeChannel(true);
    const store2 = new InMemoryTaskStore();
    const throwingRunner: AgentRunner = {
      async *run() {
        throw new Error("GLM 爆了");
      },
    };
    const orch2 = new Orchestrator({
      store: store2,
      userStore: mockUserStore(),
      conversationStore: mockConversationStore(),
      planner: new Planner(),
      gates: new GateRouter(),
      runner: throwingRunner,
      channel: channel2,
      runOptsFor: async () => ({
        cwd: ".",
        skills: [],
        llm: { model: "m", baseUrl: "u", authToken: "t" },
      }),
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
    const orch = new Orchestrator({
      store: new InMemoryTaskStore(),
      userStore: mockUserStore(),
      conversationStore: cst,
      planner: new Planner(),
      gates: new GateRouter(),
      runner: new FakeAgentRunner({ result: "ok" }),
      channel: fakeChannel(true),
      runOptsFor: async () => ({
        cwd: ".",
        skills: [],
        llm: { model: "m", baseUrl: "u", authToken: "t" },
      }),
    });
    await orch.handleMessage({ ...msg, text: "/new" });
    expect(created).toBe(true);
  });

  it("resume 透传到 runOptsFor", async () => {
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
    const orch = new Orchestrator({
      store: new InMemoryTaskStore(),
      userStore: mockUserStore(),
      conversationStore: cst,
      planner: new Planner(),
      gates: new GateRouter(),
      runner: new FakeAgentRunner({ result: "ok" }),
      channel: fakeChannel(true),
      runOptsFor: async (_t, _p, _u, opts) => {
        capturedResume = opts.resume;
        return { cwd: ".", skills: [], llm: { model: "m", baseUrl: "u", authToken: "t" } };
      },
    });
    await orch.handleMessage(msg);
    expect(capturedResume).toBe("sdk-existing");
  });
});
