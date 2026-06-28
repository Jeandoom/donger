import { describe, expect, it } from "vitest";
import { FakeAgentRunner, type FakeScript } from "../../src/adapters/fake-agent-runner.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { GateRouter } from "../../src/domain/gate-router.js";
import { Planner } from "../../src/domain/planner.js";
import type { ApprovalCard, OutgoingMessage } from "../../src/domain/types.js";
import { MemoryStore } from "../../src/memory/memory-store.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { AgentRunner, RunOptions } from "../../src/ports/agent-runner.js";
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
    // busy 已释放：后续消息不会被告知"正在处理"
    await orch2.handleMessage(msg);
    expect(channel2.sent.some((m) => m.text.includes("正在处理"))).toBe(false);
  });

  it("T5.2：任务后自动沉淀经验到 memory", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const memDir = mkdtempSync(join(tmpdir(), "donger-mem-test-"));
    const memory = new MemoryStore(memDir);
    const channel3 = fakeChannel(true);
    const store3 = new InMemoryTaskStore();
    const orch3 = new Orchestrator({
      store: store3,
      planner: new Planner(),
      gates: new GateRouter(),
      runner: new FakeAgentRunner({ intro: "done", result: "ok" }),
      channel: channel3,
      memory,
      runOptsFor: async () => ({
        cwd: ".",
        skills: [],
        llm: { model: "m", baseUrl: "u", authToken: "t" },
      }),
    });
    await orch3.handleMessage({ ...msg, text: "修一个 CSV 导出 bug" });
    const entries = memory.list();
    expect(entries.length).toBe(1);
    expect(entries[0]?.summary).toContain("CSV");
  });

  it("T5.3：任务前注入相关记忆到 systemPrompt", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const memDir = mkdtempSync(join(tmpdir(), "donger-mem-inj-"));
    const memory = new MemoryStore(memDir);
    memory.append({ summary: "CSV 导出用 stream API 更稳", detail: "避免一次性加载" });

    let capturedPrompt: string | undefined;
    const capturingRunner: AgentRunner = {
      async *run(_task, opts) {
        capturedPrompt = opts.systemPromptAppend;
        yield { type: "result", taskId: _task.id, subtype: "success", result: "ok" };
      },
    };
    const orch3 = new Orchestrator({
      store: new InMemoryTaskStore(),
      planner: new Planner(),
      gates: new GateRouter(),
      runner: capturingRunner,
      channel: fakeChannel(true),
      memory,
      runOptsFor: async () => ({
        cwd: ".",
        skills: [],
        llm: { model: "m", baseUrl: "u", authToken: "t" },
        systemPromptAppend: "base prompt",
      }),
    });
    await orch3.handleMessage({ ...msg, text: "CSV 导出" });
    expect(capturedPrompt).toContain("相关记忆");
    expect(capturedPrompt).toContain("CSV 导出用 stream");
  });
});
