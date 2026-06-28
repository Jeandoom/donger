import { describe, expect, it } from "vitest";
import { FakeAgentRunner } from "../../src/adapters/fake-agent-runner.js";
import type { RunnerEvent, Task } from "../../src/domain/types.js";
import type { ApprovalResolver } from "../../src/ports/agent-runner.js";

const task: Task = {
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

const opts = {
  cwd: ".",
  skills: [],
  llm: { model: "m", baseUrl: "u", authToken: "t" },
};

async function collect(gen: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("FakeAgentRunner", () => {
  it("intro → gate(approved) → outro → success", async () => {
    const resolver: ApprovalResolver = async () => ({ approved: true });
    const runner = new FakeAgentRunner({
      intro: "正在设计…",
      gate: { gateId: "design", summary: "方案A" },
      outro: "已完成",
      result: "ok",
    });
    const events = await collect(runner.run(task, opts, resolver));
    expect(events.map((e) => e.type)).toEqual(["text", "text", "result"]);
    const last = events[events.length - 1];
    if (last?.type === "result") expect(last.subtype).toBe("success");
  });

  it("gate denied → 立即 result error，不发 outro", async () => {
    const resolver: ApprovalResolver = async () => ({ approved: false, reason: "用户驳回" });
    const runner = new FakeAgentRunner({
      intro: "正在设计…",
      gate: { gateId: "design", summary: "方案A" },
      outro: "已完成",
    });
    const events = await collect(runner.run(task, opts, resolver));
    expect(events.map((e) => e.type)).toEqual(["text", "result"]);
    const last = events[events.length - 1];
    if (last?.type === "result") {
      expect(last.subtype).toBe("error");
      expect(last.error).toBe("用户驳回");
    }
  });

  it("无 gate → intro + success", async () => {
    const resolver: ApprovalResolver = async () => ({ approved: true });
    const runner = new FakeAgentRunner({ intro: "hi", result: "done" });
    const events = await collect(runner.run(task, opts, resolver));
    expect(events.map((e) => e.type)).toEqual(["text", "result"]);
  });

  it("approvalResolver 收到正确的 gate 信息", async () => {
    let received: { gateId: string; summary: string } | null = null;
    const resolver: ApprovalResolver = async (req) => {
      received = { gateId: req.gateId, summary: req.summary };
      return { approved: true };
    };
    const runner = new FakeAgentRunner({ gate: { gateId: "deploy", summary: "部署到 prod" } });
    await collect(runner.run(task, opts, resolver));
    expect(received).toEqual({ gateId: "deploy", summary: "部署到 prod" });
  });
});
