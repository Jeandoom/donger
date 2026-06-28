import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentRunner, type FakeScript } from "../../src/adapters/fake-agent-runner.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { GateRouter } from "../../src/domain/gate-router.js";
import { Planner } from "../../src/domain/planner.js";
import type { ApprovalCard, OutgoingMessage } from "../../src/domain/types.js";
import type { User, UserRole } from "../../src/domain/user.js";
import { MemoryStore } from "../../src/memory/memory-store.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { AgentRunner } from "../../src/ports/agent-runner.js";
import type { Channel } from "../../src/ports/channel.js";
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

function setup(approve: boolean, script: FakeScript) {
  const store = new InMemoryTaskStore();
  const channel = fakeChannel(approve);
  const runner = new FakeAgentRunner(script);
  const gates = new GateRouter();
  gates.describe({ id: "design", description: "方案审批" });
  const orch = new Orchestrator({
    store,
    userStore: mockUserStore(),
    planner: new Planner(),
    gates,
    runner,
    channel,
    runOptsFor: async (_task, plan, _user) => ({
      cwd: ".",
      skills: plan.skills,
      llm: { model: "m", baseUrl: "u", authToken: "t" },
    }),
  });
  return { orch, store, channel };
}

const msg = { channelId: "test", threadId: "th", requesterId: "u", text: "加个导出 CSV 接口" };

describe("Orchestrator", () => {
  it("收到即确认 → 代码任务全链 → done", async () => {
    const { orch, store, channel } = setup(true, {
      intro: "正在设计",
      gate: { gateId: "design", summary: "方案A" },
      outro: "完成",
      result: "ok",
    });
    await orch.handleMessage(msg);
    expect(channel.sent.some((m) => m.text.includes("收到"))).toBe(true);
    expect(channel.cards.length).toBe(1);
    expect(channel.sent.some((m) => m.text.startsWith("✅ 完成"))).toBe(true);
    expect((await store.listByStatus("done")).length).toBe(1);
  });

  it("审批驳回 → failed", async () => {
    const { orch, store, channel } = setup(false, {
      intro: "设计",
      gate: { gateId: "design", summary: "方案" },
    });
    await orch.handleMessage(msg);
    expect((await store.listByStatus("failed")).length).toBe(1);
    expect(channel.sent.some((m) => m.text.startsWith("❌ 失败"))).toBe(true);
  });

  it("非编码消息也走 agent（通用对话）", async () => {
    const { orch, store, channel } = setup(true, { intro: "你好！", result: "ok" });
    await orch.handleMessage({ ...msg, text: "你好" });
    expect(channel.sent.some((m) => m.text.includes("收到"))).toBe(true);
    expect(channel.sent.some((m) => m.text.startsWith("✅ 完成"))).toBe(true);
    expect((await store.listByStatus("done")).length).toBe(1);
  });

  it("同 thread 正在处理时，第二条回「正在处理」", async () => {
    const sent: OutgoingMessage[] = [];
    const cards: ApprovalCard[] = [];
    const deferred: { resolve?: (d: { approved: boolean; reason?: string }) => void } = {};
    const channel: Channel & { sent: typeof sent; cards: typeof cards } = {
      id: "test",
      sent,
      cards,
      onMessage: () => {},
      send: async (_t, m) => {
        sent.push(m);
      },
      requestApproval: async (_t, c) => {
        cards.push(c);
        return new Promise<{ approved: boolean; reason?: string }>((r) => {
          deferred.resolve = r;
        });
      },
    };
    const store = new InMemoryTaskStore();
    const gates = new GateRouter();
    gates.describe({ id: "design", description: "方案审批" });
    const orch = new Orchestrator({
      store,
      userStore: mockUserStore(),
      planner: new Planner(),
      gates,
      runner: new FakeAgentRunner({
        intro: "设计",
        gate: { gateId: "design", summary: "方案" },
      }),
      channel,
      runOptsFor: async (_task, plan, _user) => ({
        cwd: ".",
        skills: plan.skills,
        llm: { model: "m", baseUrl: "u", authToken: "t" },
      }),
    });

    const p1 = orch.handleMessage(msg);
    await new Promise((r) => setTimeout(r, 50));
    expect(cards.length).toBe(1);

    await orch.handleMessage(msg);
    expect(sent.some((m) => m.text.includes("正在处理"))).toBe(true);

    deferred.resolve?.({ approved: true });
    await p1;
  });

  it("runner 出错时不崩溃，回错误消息，释放 busy", async () => {
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
    expect((await store2.listByStatus("failed")).length).toBe(1);
    await orch2.handleMessage(msg);
    expect(channel2.sent.some((m) => m.text.includes("正在处理"))).toBe(false);
  });

  it("T5.2：任务后自动沉淀经验到 per-user memory", async () => {
    const memDir = mkdtempSync(join(tmpdir(), "donger-mem-test-"));
    const ust: UserStore = {
      async getOrCreate() {
        return {
          id: "u1",
          staffId: "u",
          name: "u",
          role: "user" as UserRole,
          homeDir: memDir,
          createdAt: "t",
          updatedAt: "t",
        };
      },
      async get() {
        return undefined;
      },
      async getByStaffId() {
        return undefined;
      },
      async updateRole() {},
      async list() {
        return [];
      },
    };
    const orch = new Orchestrator({
      store: new InMemoryTaskStore(),
      userStore: ust,
      planner: new Planner(),
      gates: new GateRouter(),
      runner: new FakeAgentRunner({ intro: "done", result: "ok" }),
      channel: fakeChannel(true),
      runOptsFor: async () => ({
        cwd: ".",
        skills: [],
        llm: { model: "m", baseUrl: "u", authToken: "t" },
      }),
    });
    await orch.handleMessage({ ...msg, text: "修一个 CSV 导出 bug" });
    const memStore = new MemoryStore(join(memDir, "memory"));
    expect(memStore.list().length).toBe(1);
    expect(memStore.list()[0]?.summary).toContain("CSV");
  });

  it("T10.3：runOptsFor 收到 user，worktree 走 user.homeDir", async () => {
    const memDir = mkdtempSync(join(tmpdir(), "donger-user-home-"));
    let capturedUser: User | undefined;
    const ust: UserStore = {
      async getOrCreate() {
        return {
          id: "u1",
          staffId: "u",
          name: "u",
          role: "user" as UserRole,
          homeDir: memDir,
          createdAt: "t",
          updatedAt: "t",
        };
      },
      async get() {
        return undefined;
      },
      async getByStaffId() {
        return undefined;
      },
      async updateRole() {},
      async list() {
        return [];
      },
    };
    const orch = new Orchestrator({
      store: new InMemoryTaskStore(),
      userStore: ust,
      planner: new Planner(),
      gates: new GateRouter(),
      runner: new FakeAgentRunner({ result: "ok" }),
      channel: fakeChannel(true),
      runOptsFor: async (_task, _plan, user) => {
        capturedUser = user;
        return { cwd: user.homeDir, skills: [], llm: { model: "m", baseUrl: "u", authToken: "t" } };
      },
    });
    await orch.handleMessage(msg);
    expect(capturedUser?.homeDir).toBe(memDir);
  });
});
