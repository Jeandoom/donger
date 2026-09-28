import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CodexAgentRunner,
  type CodexClientFactory,
  type CodexClientLike,
  type CodexThreadEventLike,
} from "../../src/adapters/codex-agent-runner.js";
import { CodexChatBridge } from "../../src/adapters/codex-chat-bridge.js";
import { GateRouter } from "../../src/domain/gate-router.js";
import type { LLMConfig } from "../../src/domain/llm-config.js";
import type { RunnerEvent, Task } from "../../src/domain/types.js";

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

const llm: LLMConfig = {
  model: "glm-x",
  baseUrl: "https://upstream.example/v1",
  authToken: "sk-secret",
  sdkType: "openai",
};

function fakeScript(events: CodexThreadEventLike[]): CodexClientFactory {
  return () => {
    const client: CodexClientLike = {
      startThread(options: Record<string, unknown>) {
        void options;
        return {
          id: null,
          async runStreamed(input: string, turnOptions?: { signal?: AbortSignal }) {
            void input;
            void turnOptions;
            return {
              events: (async function* () {
                for (const e of events) yield e;
              })(),
            };
          },
        };
      },
      resumeThread(threadId: string) {
        void threadId;
        return client.startThread({});
      },
    };
    return client;
  };
}

async function collect(g: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
}

describe("CodexAgentRunner", () => {
  let workspace: string;
  const bridges: CodexChatBridge[] = [];

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "codex-runner-ws-"));
  });

  afterEach(async () => {
    for (const bridge of bridges.splice(0)) await bridge.close();
  });

  function makeRunner(factory: CodexClientFactory): CodexAgentRunner {
    const bridge = new CodexChatBridge();
    bridges.push(bridge);
    return new CodexAgentRunner(new GateRouter(), bridge, factory);
  }

  it("事件映射：thread.started→session_init、agent_message 增量→text_delta、turn.completed→result+usage", async () => {
    const runner = makeRunner(
      fakeScript([
        { type: "thread.started", thread_id: "thr-1" },
        { type: "turn.started" },
        { type: "item.started", item: { id: "m1", type: "agent_message" } },
        { type: "item.updated", item: { id: "m1", type: "agent_message", text: "你" } },
        { type: "item.updated", item: { id: "m1", type: "agent_message", text: "你好" } },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "你好" } },
        {
          type: "turn.completed",
          usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
        },
      ]),
    );
    const events = await collect(
      runner.run(
        task,
        { cwd: join(workspace, "ws"), skills: [], llm, workspaceRoot: workspace },
        async () => ({
          approved: true,
        }),
      ),
    );
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("llm_input");
    expect(types).toContain("session_init");
    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas.map((e) => (e as { text: string }).text)).toEqual(["你", "好"]);
    expect(types).toContain("text");
    const result = events.at(-1) as {
      type: string;
      subtype: string;
      usage?: {
        inputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
      };
    };
    expect(result.subtype).toBe("success");
    expect(result.usage).toMatchObject({
      inputTokens: 10,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 0,
    });
  });

  it("turn.failed 错误原文透传（自愈链路依赖）", async () => {
    const runner = makeRunner(
      fakeScript([
        { type: "turn.failed", error: { message: "stream disconnected before completion" } },
      ]),
    );
    const events = await collect(
      runner.run(
        task,
        { cwd: join(workspace, "ws"), skills: [], llm, workspaceRoot: workspace },
        async () => ({ approved: true }),
      ),
    );
    const result = events.at(-1) as { type: string; subtype: string; error?: string };
    expect(result.subtype).toBe("error");
    expect(result.error).toBe("stream disconnected before completion");
  });

  it("command_execution/mcp_tool_call → tool_use/tool_result（mcp 命名与 claude 口径一致）", async () => {
    const runner = makeRunner(
      fakeScript([
        { type: "thread.started", thread_id: "thr-2" },
        {
          type: "item.started",
          item: {
            id: "c1",
            type: "command_execution",
            command: "git push origin main",
            status: "in_progress",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "c1",
            type: "command_execution",
            command: "git push",
            aggregated_output: "rejected",
            exit_code: 1,
            status: "failed",
          },
        },
        {
          type: "item.started",
          item: {
            id: "mc1",
            type: "mcp_tool_call",
            server: "donger-kb",
            tool: "kb_search",
            arguments: { q: "x" },
            status: "in_progress",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "mc1",
            type: "mcp_tool_call",
            server: "donger-kb",
            tool: "kb_search",
            arguments: {},
            status: "completed",
            result: { content: [{ type: "text", text: "命中" }] },
          },
        },
        { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
      ]),
    );
    const events = await collect(
      runner.run(
        task,
        { cwd: join(workspace, "ws"), skills: [], llm, workspaceRoot: workspace },
        async () => ({ approved: true }),
      ),
    );
    const toolUses = events.filter((e) => e.type === "tool_use");
    expect(toolUses[0]).toMatchObject({ tool: "Bash", input: { command: "git push origin main" } });
    expect(toolUses[1]).toMatchObject({ tool: "mcp__donger-kb__kb_search", input: { q: "x" } });
    const results = events.filter((e) => e.type === "tool_result");
    expect(results[0]).toMatchObject({
      content: expect.stringContaining("exit_code: 1"),
      isError: true,
    });
    expect(results[1]).toMatchObject({ content: "命中", isError: false });
  });

  it("沙箱启发：只读白名单→read-only，含写工具→workspace-write；resume 走 resumeThread", async () => {
    const captured: Record<string, unknown>[] = [];
    let resumedWith: string | null = null;
    const factory: CodexClientFactory = () => ({
      startThread(options: Record<string, unknown>) {
        captured.push(options);
        return {
          id: null,
          async runStreamed() {
            return {
              events: (async function* () {
                yield { type: "thread.started", thread_id: "new-1" };
                yield { type: "turn.completed", usage: {} };
              })(),
            };
          },
        };
      },
      resumeThread(threadId: string) {
        resumedWith = threadId;
        return {
          id: threadId,
          async runStreamed() {
            return {
              events: (async function* () {
                yield { type: "thread.started", thread_id: threadId };
                yield { type: "turn.completed", usage: {} };
              })(),
            };
          },
        };
      },
    });
    const runner = makeRunner(factory);
    const base = {
      cwd: join(workspace, "ws"),
      skills: [],
      llm,
      workspaceRoot: workspace,
      resume: "old-thread",
    };
    await collect(
      runner.run(task, { ...base, allowedTools: ["Read", "Grep", "Glob"] }, async () => ({
        approved: true,
      })),
    );
    expect(resumedWith).toBe("old-thread");
    await collect(
      runner.run(
        task,
        { ...base, resume: undefined, allowedTools: ["Read", "Grep"] },
        async () => ({ approved: true }),
      ),
    );
    expect(captured[0]).toMatchObject({ sandboxMode: "read-only" });
    await collect(
      runner.run(
        task,
        { ...base, resume: undefined, allowedTools: ["Bash", "Read"] },
        async () => ({ approved: true }),
      ),
    );
    expect(captured[1]).toMatchObject({ sandboxMode: "workspace-write" });
  });

  it("系统提示落 AGENTS.md；上游凭证不进 codex env；运行后桥上游注销", async () => {
    const bridge = new CodexChatBridge();
    bridges.push(bridge);
    let seenConfig: Record<string, unknown> | null = null;
    const factory: CodexClientFactory = (options) => {
      seenConfig = options as Record<string, unknown>;
      return {
        startThread() {
          return {
            id: null,
            async runStreamed() {
              return {
                events: (async function* () {
                  yield { type: "thread.started", thread_id: "t" };
                  yield { type: "turn.completed", usage: {} };
                })(),
              };
            },
          };
        },
        resumeThread(threadId: string) {
          void threadId;
          throw new Error("not used");
        },
      };
    };
    const runner = new CodexAgentRunner(new GateRouter(), bridge, factory);
    const cwd = join(workspace, "ws2");
    mkdirSync(cwd, { recursive: true });
    await collect(
      runner.run(
        task,
        {
          cwd,
          skills: [],
          llm,
          workspaceRoot: workspace,
          systemPromptAppend: "系统提示正文",
        },
        async () => ({ approved: true }),
      ),
    );
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toContain("系统提示正文");
    const env = (seenConfig as { env: Record<string, string> }).env;
    expect(env.CODEX_HOME).toBe(join(workspace, ".codex-home"));
    expect(JSON.stringify(env)).not.toContain("sk-secret");
    expect(bridge.upstreamCountForTests()).toBe(0);
  });

  it("白名单技能物化到 CODEX_HOME/skills（pack:skill → plugin.json 名匹配）", async () => {
    const pluginDir = join(workspace, "pack-root", ".donger-sdk-plugin");
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(pluginDir, "skills", "finder"), { recursive: true });
    writeFileSync(
      join(pluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "my-pack" }),
    );
    writeFileSync(join(pluginDir, "skills", "finder", "SKILL.md"), "---\nname: finder\n---\nbody");

    const bridge = new CodexChatBridge();
    bridges.push(bridge);
    const runner = new CodexAgentRunner(
      new GateRouter(),
      bridge,
      fakeScript([{ type: "thread.started", thread_id: "t" }]),
    );
    const cwd = join(workspace, "ws3");
    mkdirSync(cwd, { recursive: true });
    await collect(
      runner.run(
        task,
        {
          cwd,
          skills: ["my-pack:finder"],
          pluginPaths: [pluginDir],
          llm,
          workspaceRoot: workspace,
        },
        async () => ({ approved: true }),
      ),
    );
    expect(existsSync(join(workspace, ".codex-home", "skills", "finder", "SKILL.md"))).toBe(true);
  });

  it("execpolicy 规则：缺省禁全部 git，gitAllowShellGit 时仅禁 push", async () => {
    const bridge = new CodexChatBridge();
    bridges.push(bridge);
    const runner = new CodexAgentRunner(
      new GateRouter(),
      bridge,
      fakeScript([{ type: "thread.started", thread_id: "t" }]),
    );
    const cwd = join(workspace, "ws4");
    const runOpts = { cwd, skills: [], llm, workspaceRoot: workspace } as const;
    await collect(runner.run(task, runOpts, async () => ({ approved: true })));
    expect(readFileSync(join(workspace, ".codex-home", "rules", "donger.rules"), "utf8")).toContain(
      'pattern=["git"]',
    );
    await collect(
      runner.run(task, { ...runOpts, gitAllowShellGit: true }, async () => ({ approved: true })),
    );
    const rules = readFileSync(join(workspace, ".codex-home", "rules", "donger.rules"), "utf8");
    expect(rules).toContain('pattern=["git", "push"]');
    expect(rules).not.toContain('pattern=["git"]');
  });

  it("DONGER_CODEX_SANDBOX_MODE 逃生门：合法值生效、非法值回退、只读白名单不升级", async () => {
    const { resolveSandboxMode } = await import("../../src/adapters/codex-agent-runner.js");
    expect(resolveSandboxMode(undefined, "danger-full-access")).toBe("danger-full-access");
    expect(resolveSandboxMode(undefined, "bogus")).toBe("workspace-write");
    expect(resolveSandboxMode(undefined, undefined)).toBe("workspace-write");
    expect(resolveSandboxMode(["Read"], "danger-full-access")).toBe("read-only");
    expect(resolveSandboxMode(["Read"], undefined)).toBe("read-only");
  });
});
