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
  it("代码任务全链：规划→审批门→结果，任务 done", async () => {
    const { orch, store, channel } = setup(true, {
      intro: "正在设计",
      gate: { gateId: "design", summary: "方案A" },
      outro: "完成",
      result: "ok",
    });
    await orch.handleMessage(msg);

    expect(channel.cards.length).toBe(1);
    expect(channel.cards[0]?.gateId).toBe("design");
    expect(channel.sent.some((m) => m.text === "正在设计")).toBe(true);
    expect(channel.sent.some((m) => m.text.startsWith("✅ 完成"))).toBe(true);

    const done = await store.listByStatus("done");
    expect(done.length).toBe(1);
    expect(done[0]?.skillChain).toContain("superpowers:brainstorming");
  });

  it("审批驳回 → 任务 failed", async () => {
    const { orch, store, channel } = setup(false, {
      intro: "设计",
      gate: { gateId: "design", summary: "方案" },
    });
    await orch.handleMessage(msg);

    expect((await store.listByStatus("failed")).length).toBe(1);
    expect(channel.sent.some((m) => m.text.startsWith("❌ 失败"))).toBe(true);
  });

  it("未识别意图 → 回「暂未识别」+ canceled，不跑 runner", async () => {
    const { orch, store, channel } = setup(true, { result: "ok" });
    await orch.handleMessage({ ...msg, text: "今天天气怎么样" });

    expect(channel.sent.some((m) => m.text.includes("暂未识别"))).toBe(true);
    expect((await store.listByStatus("canceled")).length).toBe(1);
    expect(channel.cards.length).toBe(0);
  });
});
