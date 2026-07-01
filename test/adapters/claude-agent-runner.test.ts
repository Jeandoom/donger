import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import { ClaudeAgentRunner } from "../../src/adapters/claude-agent-runner.js";
import { GateRouter } from "../../src/domain/gate-router.js";
import type { RunnerEvent, Task } from "../../src/domain/types.js";

type CanUseToolLike = (
  tool: string,
  input: Record<string, unknown>,
  ctx: { toolUseID: string },
) => Promise<{ behavior: "allow" | "deny" }>;

const task: Task = {
  id: "t1",
  channelId: "cli",
  threadId: "th",
  requesterId: "u",
  prompt: "做某事",
  status: "running",
  skillChain: [],
  createdAt: "t",
  updatedAt: "t",
};
const opts = { cwd: ".", skills: [], llm: { model: "m", baseUrl: "u", authToken: "t" } };

let captured: { canUseTool?: CanUseToolLike } | null = null;

function mockStream(messages: unknown[]) {
  queryMock.mockImplementation((params: { options?: { canUseTool?: CanUseToolLike } }) => {
    captured = params.options ?? null;
    return (async function* () {
      for (const m of messages) yield m;
    })();
  });
}

async function collect(g: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
}

beforeEach(() => {
  queryMock.mockReset();
  captured = null;
});

describe("ClaudeAgentRunner", () => {
  it("归一 SDKMessage → RunnerEvent（system init / assistant text+tool_use / result）", async () => {
    mockStream([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls" }, id: "tu1" }],
        },
      },
      { type: "result", subtype: "success", result: "done" },
    ]);
    const runner = new ClaudeAgentRunner(new GateRouter());
    const events = await collect(runner.run(task, opts, async () => ({ approved: true })));
    expect(events.map((e) => e.type)).toEqual(["session_init", "text", "tool_use", "result"]);
    const last = events[events.length - 1];
    if (last?.type === "result") expect(last.subtype).toBe("success");
  });

  it("canUseTool：非门 → allow，不调 resolver", async () => {
    mockStream([{ type: "result", subtype: "success", result: "x" }]);
    const gates = new GateRouter();
    gates.add({ gateId: "deploy", toolName: "Bash", commandPattern: /deploy/ });
    const runner = new ClaudeAgentRunner(gates);
    let calls = 0;
    await collect(
      runner.run(task, opts, async () => {
        calls++;
        return { approved: true };
      }),
    );
    const r = await captured?.canUseTool?.("Bash", { command: "ls" }, { toolUseID: "tu" });
    expect(r?.behavior).toBe("allow");
    expect(calls).toBe(0);
  });

  it("canUseTool：命中门 → 调 resolver，deny 时返回 deny", async () => {
    mockStream([{ type: "result", subtype: "success", result: "x" }]);
    const gates = new GateRouter();
    gates.add({ gateId: "deploy", toolName: "Bash", commandPattern: /deploy/ });
    const runner = new ClaudeAgentRunner(gates);
    const seen: string[] = [];
    await collect(
      runner.run(task, opts, async (req) => {
        seen.push(req.gateId);
        return { approved: false, reason: "no" };
      }),
    );
    const r = await captured?.canUseTool?.(
      "Bash",
      { command: "npm run deploy" },
      { toolUseID: "tu" },
    );
    expect(r?.behavior).toBe("deny");
    expect(seen).toEqual(["deploy"]);
  });

  it("result 携带 usage（snake_case → camelCase）", async () => {
    mockStream([
      {
        type: "result",
        subtype: "success",
        result: "done",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 8,
          cache_read_input_tokens: 3,
        },
      },
    ]);
    const runner = new ClaudeAgentRunner(new GateRouter());
    const events = await collect(runner.run(task, opts, async () => ({ approved: true })));
    const last = events[events.length - 1];
    expect(last?.type).toBe("result");
    if (last?.type === "result") {
      expect(last.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 8,
        cacheReadInputTokens: 3,
      });
    }
  });

  it("result 无 usage → usage undefined（不爆）", async () => {
    mockStream([{ type: "result", subtype: "success", result: "done" }]);
    const runner = new ClaudeAgentRunner(new GateRouter());
    const events = await collect(runner.run(task, opts, async () => ({ approved: true })));
    const last = events[events.length - 1];
    if (last?.type === "result") expect(last.usage).toBeUndefined();
  });

  it("user 消息的 tool_result → tool_result 事件", async () => {
    mockStream([
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls" }, id: "tu1" }],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu1", content: "file.txt", is_error: false },
          ],
        },
      },
      { type: "result", subtype: "success", result: "done" },
    ]);
    const runner = new ClaudeAgentRunner(new GateRouter());
    const events = await collect(runner.run(task, opts, async () => ({ approved: true })));
    const tr = events.find((e) => e.type === "tool_result");
    expect(tr).toBeDefined();
    if (tr?.type === "tool_result") {
      expect(tr.toolUseId).toBe("tu1");
      expect(tr.content).toBe("file.txt");
      expect(tr.isError).toBe(false);
    }
  });

  it("tool_result.content 为数组时 JSON 文本化", async () => {
    mockStream([
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu9",
              content: [{ type: "text", text: "x" }],
              is_error: true,
            },
          ],
        },
      },
      { type: "result", subtype: "success", result: "done" },
    ]);
    const runner = new ClaudeAgentRunner(new GateRouter());
    const events = await collect(runner.run(task, opts, async () => ({ approved: true })));
    const tr = events.find((e) => e.type === "tool_result");
    if (tr?.type === "tool_result") {
      expect(tr.isError).toBe(true);
      expect(tr.content).toContain('"text"');
    }
  });
});
