import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/domain/agent.js";
import type { Conversation } from "../../src/domain/conversation.js";
import type { RunnerEvent, Task } from "../../src/domain/types.js";
import type { User } from "../../src/domain/user.js";
import { buildDispatcherAgent, dispatchTask } from "../../src/orchestrator/dispatch-flow.js";
import type { RuntimeManager } from "../../src/orchestrator/runtime-manager.js";
import type { AgentRunner, RunOptions } from "../../src/ports/agent-runner.js";

const KB_DIR = "/tmp/ws/kb";

const user: User = {
  id: "u1",
  name: "tester",
  role: "user",
  homeDir: "/tmp/ws/users/u1",
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
};

const conversation: Conversation = {
  id: "c1",
  userId: "u1",
  sdkSessionId: "sess-1",
  title: "t",
  channelId: "web",
  agentId: "",
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
  archived: false,
};

const ROUTE_JSON = JSON.stringify({
  agentId: "agent-ops",
  requiresDesign: false,
  taskType: "ops-inspect",
  rationale: "巡检任务",
});

// prepare 打桩：只提供 llm，不触真实 store
const runtimeMgr = {
  prepare: async (_u: User, _c: Conversation, _opts: { agent?: Agent }) => ({
    context: {},
    runOptions: {
      cwd: "/tmp/ws",
      skills: [],
      pluginPaths: [],
      llm: { model: "glm-4", baseUrl: "https://example", authToken: "k" },
    },
  }),
} as unknown as RuntimeManager;

function runnerCapturing(
  onOpts: (opts: RunOptions, task: Task) => void,
  resultText: string,
): AgentRunner {
  return {
    async *run(task, opts): AsyncIterable<RunnerEvent> {
      onOpts(opts, task);
      yield { type: "result", taskId: task.id, subtype: "success", result: resultText };
    },
  };
}

describe("buildDispatcherAgent", () => {
  it("知识库以只读扩展目录注入，工具只读白名单", () => {
    const agent = buildDispatcherAgent(KB_DIR);
    expect(agent.id).toBe("builtin-dispatcher");
    expect(agent.skills).toEqual(["task-dispatch"]);
    expect(agent.tools).toEqual({ mode: "whitelist", whitelist: ["Read", "Glob"] });
    expect(agent.extensionDirectories).toEqual([
      {
        id: "kb-dispatcher",
        name: "任务管理知识库",
        path: join(KB_DIR, "dispatcher"),
        access: "readOnly",
      },
    ]);
  });
});

describe("dispatchTask", () => {
  const params = {
    runner: undefined as unknown as AgentRunner,
    runtimeMgr,
    user,
    conversation,
    prompt: "检查线上 SLS 错误日志",
    kbDir: KB_DIR,
  };

  it("解析 result 中的路由 JSON，且不续接用户会话", async () => {
    let captured: RunOptions | undefined;
    params.runner = runnerCapturing((o) => (captured = o), `\`\`\`json\n${ROUTE_JSON}\n\`\`\``);
    const routing = await dispatchTask(params);
    expect(routing.agentId).toBe("agent-ops");
    expect(captured?.resume).toBeUndefined();
    expect(captured?.sessionStore).toBeUndefined();
    expect(captured?.skills).toEqual(["task-dispatch"]);
  });

  it("prepare 收到的是 dispatcher agent（而非会话 agent）", async () => {
    let gotAgent: Agent | undefined;
    const spyMgr = {
      prepare: async (_u: User, _c: Conversation, opts: { agent?: Agent }) => {
        gotAgent = opts.agent;
        return {
          context: {},
          runOptions: {
            cwd: "/tmp/ws",
            skills: [],
            pluginPaths: [],
            llm: { model: "glm-4", baseUrl: "https://example", authToken: "k" },
          },
        };
      },
    } as unknown as RuntimeManager;
    params.runner = runnerCapturing(() => {}, ROUTE_JSON);
    await dispatchTask({ ...params, runtimeMgr: spyMgr });
    expect(gotAgent?.id).toBe("builtin-dispatcher");
  });

  it("runner 报错时抛 DISPATCH_FAILED", async () => {
    params.runner = {
      async *run(task): AsyncIterable<RunnerEvent> {
        yield { type: "result", taskId: task.id, subtype: "error", error: "boom" };
      },
    };
    await expect(dispatchTask(params)).rejects.toThrow(/DISPATCH_FAILED|任务分发失败/);
  });

  it("输出无法解析时抛 DISPATCH_FAILED", async () => {
    params.runner = runnerCapturing(() => {}, "登记表为空，无法路由");
    await expect(dispatchTask(params)).rejects.toThrow(/DISPATCH_FAILED|任务分发失败/);
  });
});
