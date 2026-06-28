import { describe, expect, it } from "vitest";
import { FakeAgentRunner, type FakeScript } from "../../src/adapters/fake-agent-runner.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { GateRouter } from "../../src/domain/gate-router.js";
import { Planner } from "../../src/domain/planner.js";
import type { ApprovalCard, OutgoingMessage } from "../../src/domain/types.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { Channel } from "../../src/ports/channel.js";

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

function setup(approve: boolean, script: FakeScript) {
  const store = new InMemoryTaskStore();
  const channel = fakeChannel(approve);
  const runner = new FakeAgentRunner(script);
  const gates = new GateRouter();
  gates.describe({ id: "design", description: "方案审批" });
  const orch = new Orchestrator({
    store,
    planner: new Planner(),
    gates,
    runner,
    channel,
    runOptsFor: async (_task, plan) => ({
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
      planner: new Planner(),
      gates,
      runner: new FakeAgentRunner({
        intro: "设计",
        gate: { gateId: "design", summary: "方案" },
      }),
      channel,
      runOptsFor: async (_task, plan) => ({
        cwd: ".",
        skills: plan.skills,
        llm: { model: "m", baseUrl: "u", authToken: "t" },
      }),
    });

    // 第一条：启动 → 卡在审批门（requestApproval 不 resolve）
    const p1 = orch.handleMessage(msg);
    await new Promise((r) => setTimeout(r, 50));
    expect(cards.length).toBe(1); // 第一条推了审批卡

    // 第二条：同 thread → busy → "正在处理"
    await orch.handleMessage(msg);
    expect(sent.some((m) => m.text.includes("正在处理"))).toBe(true);

    // 清理：resolve 审批 → 第一条完成
    deferred.resolve?.({ approved: true });
    await p1;
  });
});
