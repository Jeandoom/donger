import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

let captured: {
  canUseTool?: CanUseToolLike;
  includePartialMessages?: boolean;
  sandbox?: {
    enabled?: boolean;
    failIfUnavailable?: boolean;
    allowUnsandboxedCommands?: boolean;
  };
  settingSources?: string[];
  additionalDirectories?: string[];
} | null = null;

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
  it("以可用性优先模式启用 SDK sandbox", async () => {
    mockStream([{ type: "result", subtype: "success", result: "x" }]);

    const runner = new ClaudeAgentRunner(new GateRouter());
    await collect(runner.run(task, opts, async () => ({ approved: true })));

    expect(captured?.settingSources).toEqual(["project"]);
    expect(captured?.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: false,
      allowUnsandboxedCommands: true,
    });
  });

  it("透传扩展目录并允许 direct write tools 写入读写目录", async () => {
    const extension = mkdtempSync(join(tmpdir(), "extension-write-"));
    mockStream([{ type: "result", subtype: "success", result: "x" }]);
    const runner = new ClaudeAgentRunner(new GateRouter());
    await collect(
      runner.run(
        task,
        {
          ...opts,
          workspaceRoot: join(extension, "workspace"),
          additionalDirectories: [extension],
          allowedWriteRoots: [extension],
          readOnlyRoots: [join(extension, "readonly")],
        },
        async () => ({ approved: true }),
      ),
    );
    expect(captured?.additionalDirectories).toEqual([extension]);
    const decision = await captured?.canUseTool?.(
      "Write",
      { file_path: join(extension, "a.txt"), content: "x" },
      { toolUseID: "tu" },
    );
    expect(decision?.behavior).toBe("allow");
    const denied = await captured?.canUseTool?.(
      "Write",
      { file_path: join(extension, "readonly", "a.txt"), content: "x" },
      { toolUseID: "tu-readonly" },
    );
    expect(denied?.behavior).toBe("deny");
  });

  it("启用 partial messages 并把 text delta 转成 RunnerEvent", async () => {
    mockStream([
      {
        type: "stream_event",
        event: { type: "message_start", message: { id: "msg-1" } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "!" } },
      },
      { type: "stream_event", event: { type: "message_stop" } },
      { type: "assistant", message: { content: [{ type: "text", text: "Hi!" }] } },
      { type: "result", subtype: "success", result: "Hi!" },
    ]);

    const runner = new ClaudeAgentRunner(new GateRouter());
    const events = await collect(runner.run(task, opts, async () => ({ approved: true })));

    expect(captured?.includePartialMessages).toBe(true);
    expect(
      events.filter((event) => event.type !== "llm_input" && event.type !== "llm_output"),
    ).toEqual([
      { type: "text_delta", taskId: "t1", messageId: "msg-1", text: "Hi" },
      { type: "text_delta", taskId: "t1", messageId: "msg-1", text: "!" },
      { type: "text", taskId: "t1", text: "Hi!" },
      { type: "result", taskId: "t1", subtype: "success", result: "Hi!", usage: undefined },
    ]);
    expect(events.find((event) => event.type === "llm_input")?.input).toContain(
      '"prompt": "做某事"',
    );
    const outputs = events.filter((event) => event.type === "llm_output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.output).toContain('"assistant"');
  });

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
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu1", content: "file.txt" }],
        },
      },
      { type: "result", subtype: "success", result: "done" },
    ]);
    const runner = new ClaudeAgentRunner(new GateRouter());
    const events = await collect(runner.run(task, opts, async () => ({ approved: true })));
    expect(
      events.map((e) => e.type).filter((type) => type !== "llm_input" && type !== "llm_output"),
    ).toEqual(["session_init", "text", "tool_use", "tool_result", "result"]);
    const outputs = events.filter((event) => event.type === "llm_output");
    expect(outputs).toHaveLength(2);
    expect(outputs[1]?.output).toContain('"tool_use"');
    expect(events.filter((event) => event.type === "llm_input")).toHaveLength(2);
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

  it("canUseTool：只读命令豁免审批门（不调 resolver，复盘 P2-9）", async () => {
    mockStream([{ type: "result", subtype: "success", result: "x" }]);
    const gates = new GateRouter();
    gates.add({ gateId: "deploy", toolName: "Bash", commandPattern: /release/ });
    const runner = new ClaudeAgentRunner(gates);
    const seen: string[] = [];
    // 事故路径：aix-py 类开发型 agent 开启了 shell git 逃生门，fetch 直跑才可能抵达审批门
    await collect(
      runner.run(task, { ...opts, gitAllowShellGit: true }, async (req) => {
        seen.push(req.gateId);
        return { approved: true };
      }),
    );
    const r = await captured?.canUseTool?.(
      "Bash",
      { command: "git fetch origin release-202608-1" },
      { toolUseID: "tu" },
    );
    expect(r?.behavior).toBe("allow");
    expect(seen).toEqual([]);
    // 写操作不豁免：仍咨询审批门
    const gated = await captured?.canUseTool?.(
      "Bash",
      { command: "git push origin release-202608-1" },
      { toolUseID: "tu2" },
    );
    expect(gated?.behavior).toBe("allow");
    expect(seen).toEqual(["deploy"]);
  });

  it("canUseTool：allowedTools 白名单外的工具 → deny（约束只读 agent 不放行 Bash）", async () => {
    mockStream([]);
    const runner = new ClaudeAgentRunner(new GateRouter());
    // 消费 generator 触发 query 调用，捕获 options.canUseTool
    await collect(
      runner.run(task, { ...opts, allowedTools: ["Read", "Glob"] }, async () => ({
        approved: true,
      })),
    );
    const r = await captured?.canUseTool?.("Bash", { command: "ls" }, { toolUseID: "tu" });
    expect(r?.behavior).toBe("deny");
    const ok = await captured?.canUseTool?.("Read", { file_path: "x" }, { toolUseID: "tu2" });
    expect(ok?.behavior).toBe("allow");
  });

  it("canUseTool：shell git 守卫矩阵（防线 2）", async () => {
    mockStream([]);
    const runner = new ClaudeAgentRunner(new GateRouter());

    // gitAllowShellGit=false（agent 默认）：Bash 跑 git → deny 并引导工具
    await collect(
      runner.run(task, { ...opts, gitAllowShellGit: false }, async () => ({ approved: true })),
    );
    const denied = await captured?.canUseTool?.(
      "Bash",
      { command: "git push origin main" },
      { toolUseID: "tu-git" },
    );
    expect(denied?.behavior).toBe("deny");
    expect(denied?.message).toContain("donger-git");
    // 非 git 命令不受影响
    const other = await captured?.canUseTool?.(
      "Bash",
      { command: "ls -la" },
      { toolUseID: "tu-ls" },
    );
    expect(other?.behavior).toBe("allow");

    // gitAllowShellGit=true（逃生门）：放行（push 由 deploy 审批门在 gates.match 兜底）
    await collect(
      runner.run(task, { ...opts, gitAllowShellGit: true }, async () => ({ approved: true })),
    );
    const allowed = await captured?.canUseTool?.(
      "Bash",
      { command: "git status" },
      { toolUseID: "tu-ok" },
    );
    expect(allowed?.behavior).toBe("allow");

    // undefined（未传）：全域缺省禁止（CLI/闲聊会话同样收口）
    await collect(runner.run(task, { ...opts }, async () => ({ approved: true })));
    const legacy = await captured?.canUseTool?.(
      "Bash",
      { command: "git status" },
      { toolUseID: "tu-legacy" },
    );
    expect(legacy?.behavior).toBe("deny");
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

  it("result error → 透传 SDK errors[] 原始文本（session 过期重试依赖该文本匹配）", async () => {
    mockStream([
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [
          "Claude Code returned an error result: No conversation found with session ID: 9b7d512b",
        ],
      },
    ]);
    const runner = new ClaudeAgentRunner(new GateRouter());
    const events = await collect(runner.run(task, opts, async () => ({ approved: true })));
    const last = events[events.length - 1];
    expect(last?.type).toBe("result");
    if (last?.type === "result") {
      expect(last.subtype).toBe("error");
      expect(last.error).toContain("No conversation found with session ID");
    }
  });

  it("result error 无 errors 字段 → 兜底固定文案（不爆）", async () => {
    mockStream([{ type: "result", subtype: "error_during_execution", is_error: true }]);
    const runner = new ClaudeAgentRunner(new GateRouter());
    const events = await collect(runner.run(task, opts, async () => ({ approved: true })));
    const last = events[events.length - 1];
    if (last?.type === "result") expect(last.error).toBe("agent 执行出错");
  });

  it("canUseTool：写入越界 workspaceRoot → deny", async () => {
    const ws = mkdtempSync(join(tmpdir(), "wsroot-"));
    mockStream([{ type: "result", subtype: "success", result: "x" }]);
    const runner = new ClaudeAgentRunner(new GateRouter());
    await collect(
      runner.run(task, { ...opts, workspaceRoot: ws }, async () => ({ approved: true })),
    );
    const r = await captured?.canUseTool?.(
      "Write",
      { file_path: "/etc/passwd", content: "x" },
      { toolUseID: "tu" },
    );
    expect(r?.behavior).toBe("deny");
  });

  it("canUseTool：写入在 workspaceRoot 内 → allow", async () => {
    const ws = mkdtempSync(join(tmpdir(), "wsroot-"));
    mockStream([{ type: "result", subtype: "success", result: "x" }]);
    const runner = new ClaudeAgentRunner(new GateRouter());
    await collect(
      runner.run(task, { ...opts, workspaceRoot: ws }, async () => ({ approved: true })),
    );
    const r = await captured?.canUseTool?.(
      "Write",
      { file_path: join(ws, "sessions", "c1", "a.txt"), content: "x" },
      { toolUseID: "tu" },
    );
    expect(r?.behavior).toBe("allow");
  });

  it("sessionStore 透传到 query options", async () => {
    mockStream([{ type: "result", subtype: "success", result: "x" }]);
    const fakeSessionStore = {
      append: () => Promise.resolve(),
      load: () => Promise.resolve(null),
    };
    const runner = new ClaudeAgentRunner(new GateRouter());
    await collect(
      runner.run(task, { ...opts, sessionStore: fakeSessionStore as never }, async () => ({
        approved: true,
      })),
    );
    expect(captured?.sessionStore).toBe(fakeSessionStore);
  });

  it("无 sessionStore 时 query options 不含 sessionStore 字段", async () => {
    mockStream([{ type: "result", subtype: "success", result: "x" }]);
    const runner = new ClaudeAgentRunner(new GateRouter());
    await collect(runner.run(task, opts, async () => ({ approved: true })));
    expect(captured?.sessionStore).toBeUndefined();
  });

  it("pythonPaths 并入子进程 PYTHONPATH（插件共享运行库桥，复盘 P2-10）", async () => {
    mockStream([{ type: "result", subtype: "success", result: "x" }]);
    process.env.PYTHONPATH = "D:\\existing\\libs";
    const runner = new ClaudeAgentRunner(new GateRouter());
    await collect(
      runner.run(
        task,
        { ...opts, pythonPaths: ["C:\\ws\\.skills\\copilot-skills\\.donger-sdk-plugin\\scripts"] },
        async () => ({ approved: true }),
      ),
    );
    const env = (captured as unknown as { env: Record<string, string> })?.env;
    expect(env.PYTHONPATH).toContain("copilot-skills");
    expect(env.PYTHONPATH).toContain("D:\\existing\\libs");
    delete process.env.PYTHONPATH;
  });
});

describe("ClaudeAgentRunner agent options 透传", () => {
  it("allowedTools 与 mcpServers 透传给 query", async () => {
    mockStream([{ type: "result", subtype: "success", result: "x" }]);
    const runner = new ClaudeAgentRunner(new GateRouter());
    await collect(
      runner.run(
        task,
        {
          ...opts,
          allowedTools: ["Bash", "Read"],
          mcpServers: [
            { name: "fs", type: "http", url: "https://x" },
            { name: "sh", type: "stdio", command: "npx", args: ["s"] },
          ],
        },
        async () => ({ approved: true }),
      ),
    );
    const callArg = queryMock.mock.calls[0]?.[0] as {
      options?: { allowedTools?: string[]; mcpServers?: Record<string, unknown> };
    };
    expect(callArg.options?.allowedTools).toEqual(["Bash", "Read"]);
    const mcp = callArg.options?.mcpServers;
    expect(mcp && "fs" in mcp && "sh" in mcp).toBe(true);
    expect((mcp as { fs: { type: string } }).fs.type).toBe("http");
    expect((mcp as { sh: { command: string } }).sh.command).toBe("npx");
  });

  it("无 allowedTools/mcpServers 时 query options 不含这两个字段", async () => {
    mockStream([{ type: "result", subtype: "success", result: "x" }]);
    const runner = new ClaudeAgentRunner(new GateRouter());
    await collect(runner.run(task, opts, async () => ({ approved: true })));
    const callArg = queryMock.mock.calls[0]?.[0] as {
      options?: { allowedTools?: unknown; mcpServers?: unknown };
    };
    expect(callArg.options?.allowedTools).toBeUndefined();
    expect(callArg.options?.mcpServers).toBeUndefined();
  });
});
