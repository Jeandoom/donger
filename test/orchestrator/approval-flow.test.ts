import { describe, expect, it } from "vitest";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { GateRouter } from "../../src/domain/gate-router.js";
import type { ApprovalCard, Task } from "../../src/domain/types.js";
import { makeApprovalResolver } from "../../src/orchestrator/approval-flow.js";
import type { Channel } from "../../src/ports/channel.js";

const baseTask: Task = {
  id: "t1",
  channelId: "cli",
  threadId: "th",
  requesterId: "u",
  prompt: "p",
  status: "running",
  skillChain: [],
  createdAt: "t",
  updatedAt: "t",
};

function fakeChannel(decision: { approved: boolean; reason?: string }): Channel & {
  state: { card?: ApprovalCard };
} {
  const state: { card?: ApprovalCard } = {};
  const ch: Channel & { state: { card?: ApprovalCard } } = {
    id: "test",
    state,
    onMessage: () => {},
    send: async () => {},
    requestApproval: async (_t, c) => {
      state.card = c;
      return decision;
    },
  };
  return ch;
}

describe("makeApprovalResolver", () => {
  it("approved：状态 running→awaiting_approval→running，返回 approved，推卡（title 取 gate 描述）", async () => {
    const store = new InMemoryTaskStore();
    await store.create({ ...baseTask, status: "running" });
    const gates = new GateRouter();
    gates.describe({ id: "design", description: "方案审批" });
    const ch = fakeChannel({ approved: true });

    const resolver = makeApprovalResolver(store, ch, "th", gates);
    const decision = await resolver({
      taskId: "t1",
      gateId: "design",
      tool: "Bash",
      toolUseId: "tu",
      input: {},
      summary: "方案A",
    });

    expect(decision.approved).toBe(true);
    expect((await store.get("t1"))?.status).toBe("running");
    expect(ch.state.card?.title).toBe("审批门：方案审批");
    expect(ch.state.card?.summary).toBe("方案A");
  });

  it("denied：返回 approved=false + reason", async () => {
    const store = new InMemoryTaskStore();
    await store.create({ ...baseTask, status: "running" });
    const ch = fakeChannel({ approved: false, reason: "用户驳回" });
    const resolver = makeApprovalResolver(store, ch, "th", new GateRouter());
    const decision = await resolver({
      taskId: "t1",
      gateId: "design",
      tool: "Bash",
      toolUseId: "tu",
      input: {},
      summary: "x",
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe("用户驳回");
  });

  it("gate 未描述时 title 回退到 gateId", async () => {
    const store = new InMemoryTaskStore();
    await store.create({ ...baseTask, status: "running" });
    const ch = fakeChannel({ approved: true });
    const resolver = makeApprovalResolver(store, ch, "th", new GateRouter());
    await resolver({
      taskId: "t1",
      gateId: "deploy",
      tool: "Bash",
      toolUseId: "tu",
      input: {},
      summary: "部署",
    });
    expect(ch.state.card?.title).toBe("审批门：deploy");
  });
});
