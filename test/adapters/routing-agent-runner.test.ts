import { describe, expect, it } from "vitest";
import { RoutingAgentRunner } from "../../src/adapters/routing-agent-runner.js";
import type { AgentRunner, ApprovalResolver, RunOptions } from "../../src/ports/agent-runner.js";
import type { LLMConfig } from "../../src/domain/llm-config.js";
import type { RunnerEvent, Task } from "../../src/domain/types.js";

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

function fakeRunner(tag: string, awaiting: boolean): AgentRunner {
  return {
    run(_task: Task, _opts: RunOptions, _resolver: ApprovalResolver): AsyncIterable<RunnerEvent> {
      void tag;
      return (async function* () {
        yield { type: "text", taskId: "t1", text: tag };
      })();
    },
    ...(awaiting
      ? { isAwaitingUserInput: (taskId: string) => taskId === "t1" }
      : {}),
  };
}

function optsFor(sdkType: LLMConfig["sdkType"]): RunOptions {
  return { cwd: ".", skills: [], llm: { model: "m", baseUrl: "u", authToken: "k", sdkType } };
}

async function firstText(events: AsyncIterable<RunnerEvent>): Promise<string> {
  for await (const e of events) {
    if (e.type === "text") return e.text;
  }
  return "";
}

describe("RoutingAgentRunner", () => {
  const resolver: ApprovalResolver = async () => ({ approved: true });

  it("anthropic（缺省）路由 claude 引擎，openai 路由 codex 引擎", async () => {
    const router = new RoutingAgentRunner(fakeRunner("claude", false), fakeRunner("codex", false));
    expect(await firstText(router.run(task, optsFor("anthropic"), resolver))).toBe("claude");
    expect(await firstText(router.run(task, optsFor(undefined), resolver))).toBe("claude");
    expect(await firstText(router.run(task, optsFor("openai"), resolver))).toBe("codex");
  });

  it("isAwaitingUserInput 仅向 claude 侧透传", () => {
    const router = new RoutingAgentRunner(fakeRunner("claude", true), fakeRunner("codex", false));
    expect(router.isAwaitingUserInput?.("t1")).toBe(true);
    const router2 = new RoutingAgentRunner(fakeRunner("claude", false), fakeRunner("codex", true));
    expect(router2.isAwaitingUserInput?.("t1")).toBe(false);
  });
});
