import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpHttpBridge } from "../../src/adapters/mcp-http-bridge.js";
import {
  createMcpGateCheck,
  resolveToolDenylist,
  resolveZcodeMode,
  writeProviderConfig,
  ZcodeAgentRunner,
} from "../../src/adapters/zcode-agent-runner.js";
import type {
  ZcodeConnection,
  ZcodeConnectionFactory,
  ZcodeConnectionHandlers,
  ZcodeSessionEventParams,
  ZcodeSpawnOptions,
} from "../../src/adapters/zcode-protocol-client.js";
import type { GateRouter } from "../../src/domain/gate-router.js";
import type { LLMConfig } from "../../src/domain/llm-config.js";
import type { ApprovalDecision, RunnerEvent, Task } from "../../src/domain/types.js";
import type { ApprovalResolver, RunOptions } from "../../src/ports/agent-runner.js";

// —— 假 app-server：记录请求、按脚本回放事件与反向请求 ——

interface ScriptedReverse {
  method: string;
  params: Record<string, unknown>;
  /** 宿主应答落点（runner 对反向请求的返回值） */
  answered: unknown;
}

class FakeZcodeServer {
  requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  handlers: ZcodeConnectionHandlers | null = null;
  closed = false;
  sessionId = "sess_fake_1";
  eventsAfterSend: ZcodeSessionEventParams[] = [];
  reverseOnSend: ScriptedReverse[] = [];
  failOnCreate: Error | null = null;

  connection(): ZcodeConnection {
    return {
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        this.requests.push({ method, params: (params ?? {}) as Record<string, unknown> });
        if (method === "session/create") {
          if (this.failOnCreate) throw this.failOnCreate;
          return { session: { sessionId: this.sessionId } } as T;
        }
        if (method === "session/send") {
          for (const rev of this.reverseOnSend) {
            rev.answered = await this.handlers?.onRequest(rev.method, rev.params);
          }
          for (const event of this.eventsAfterSend) {
            this.handlers?.onSessionEvent?.(event);
          }
          return { accepted: true } as T;
        }
        return {} as T;
      },
      notify: () => {},
      close: () => {
        this.closed = true;
      },
      exitCode: null,
    };
  }

  request(method: string): Record<string, unknown> | undefined {
    return this.requests.find((r) => r.method === method)?.params;
  }
}

function factoryFor(server: FakeZcodeServer): {
  factory: ZcodeConnectionFactory;
  spawned: ZcodeSpawnOptions[];
} {
  const spawned: ZcodeSpawnOptions[] = [];
  const factory: ZcodeConnectionFactory = (options, handlers) => {
    spawned.push(options);
    server.handlers = handlers;
    return server.connection();
  };
  return { factory, spawned };
}

// —— 测试脚手架 ——

function makeGates(
  rules: Array<{ gateId: string; toolName: string; force?: boolean }>,
): GateRouter {
  // 轻量假对象：GateRouter 仅消费 match(toolName, input)
  const byTool = new Map(rules.map((r) => [r.toolName, r]));
  return {
    match: (toolName: string) => {
      const hit = byTool.get(toolName);
      return hit ? { gateId: hit.gateId, force: hit.force } : undefined;
    },
  } as unknown as GateRouter;
}

const llm: LLMConfig = {
  model: "glm-4.6",
  baseUrl: "https://open.bigmodel.cn/api/anthropic",
  authToken: "sk-donger-user-key",
  sdkType: "zcode",
};

function baseOpts(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    cwd: tmpWork.dir,
    skills: [],
    llm,
    workspaceRoot: tmpWork.dir,
    allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "TodoWrite"],
    ...overrides,
  };
}

const task: Task = {
  id: "t-zcode",
  channelId: "web",
  threadId: "conv1",
  requesterId: "u1",
  prompt: "跑一下测试",
  status: "running",
  skillChain: [],
  createdAt: "t",
  updatedAt: "t",
};

const tmpWork = { dir: "" };
let dirs: string[] = [];
function newWorkDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-runner-test-"));
  dirs.push(dir);
  tmpWork.dir = dir;
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

async function collect(events: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const completedEvent = (response: string): ZcodeSessionEventParams => ({
  type: "turn.completed",
  payload: {
    response,
    tokenCount: 10,
    toolCallCount: 0,
    duration: 1200,
    resultType: "success",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 },
  },
});

describe("ZcodeAgentRunner", () => {
  it("提示链交付：systemPromptAppend 写入 workspace AGENTS.md（三引擎等价，spec §4.0）", async () => {
    newWorkDir();
    const server = new FakeZcodeServer();
    server.eventsAfterSend = [completedEvent("done")];
    const runner = new ZcodeAgentRunner(makeGates([]), factoryFor(server).factory);
    await collect(
      runner.run(task, baseOpts({ systemPromptAppend: "平台提示链正文身份节" }), async () => ({
        approved: true,
      })),
    );
    expect(readFileSync(join(tmpWork.dir, "AGENTS.md"), "utf8")).toContain("平台提示链正文身份节");
  });

  it("提示链缺省时不写 AGENTS.md（不在用户工作区留空壳文件）", async () => {
    newWorkDir();
    const server = new FakeZcodeServer();
    server.eventsAfterSend = [completedEvent("done")];
    const runner = new ZcodeAgentRunner(makeGates([]), factoryFor(server).factory);
    await collect(runner.run(task, baseOpts(), async () => ({ approved: true })));
    expect(existsSync(join(tmpWork.dir, "AGENTS.md"))).toBe(false);
  });

  it("协议握手序列：create(mode/denylist) → subscribe → send(modelSelection)，轮末删凭证配置", async () => {
    const dir = newWorkDir();
    const server = new FakeZcodeServer();
    server.eventsAfterSend = [completedEvent("done")];
    const { factory, spawned } = factoryFor(server);
    let providerSnapshot = "";
    const snapshotFactory: ZcodeConnectionFactory = (options, handlers) => {
      // runner 写好 provider 配置后才接线工厂：此处读到的即本轮实际物化内容
      providerSnapshot = readFileSync(
        options.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ?? "",
        "utf8",
      );
      return factory(options, handlers);
    };
    const runner = new ZcodeAgentRunner(makeGates([]), snapshotFactory);

    await collect(runner.run(task, baseOpts(), async () => ({ approved: true })));

    const create = server.request("session/create");
    expect(create?.mode).toBe("build");
    expect(create?.workspace).toEqual({
      workspacePath: dir,
      workspaceKey: dir,
    });
    // 白名单补集下发（词表 ∖ allowedTools）
    const denylist = create?.toolDenylist as string[];
    expect(denylist).toContain("WebSearch");
    expect(denylist).toContain("WebFetch");
    expect(denylist).not.toContain("Bash");

    const send = server.request("session/send");
    expect(send?.modelSelection).toEqual({
      providerId: "donger-glm",
      modelId: "glm-4.6",
      options: { reasoningLevel: "enabled" },
    });

    // GLM key 物化进 provider 配置并在轮末删除（不落盘残留）。
    // 内容在 factory 接线时快照（轮末文件已删，事后无法读取）。
    const conn = spawned.at(0);
    if (!conn) throw new Error("factory 未被调用");
    const providerPath = conn.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ?? "";
    const written = JSON.parse(providerSnapshot) as {
      config: {
        providerConfigRules: {
          providerRules: Array<{ providerId: string; config: Record<string, unknown> }>;
        };
      };
    };
    const rule = written.config.providerConfigRules.providerRules.at(0);
    if (!rule) throw new Error("provider 规则缺失");
    expect(rule.providerId).toBe("donger-glm");
    expect(rule.config.api).toEqual({
      type: "anthropic-messages",
      baseUrl: llm.baseUrl,
    });
    expect((rule.config.access as Record<string, unknown>).apiKey).toBe("sk-donger-user-key");
    // builtin/personal 成对 env 显式设置（builtin 探测安装自带资产）
    expect(conn.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ?? "").not.toBe("");
    expect(conn.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).toBe(providerPath);
    expect(conn.env.HOME).toContain(".zcode-home");
    expect(existsSync(providerPath)).toBe(false);
    expect(server.closed).toBe(true);
  });

  it("事件映射：text/reasoning delta、tool_use/tool_result、turn.completed→result+usage", async () => {
    newWorkDir();
    const server = new FakeZcodeServer();
    server.eventsAfterSend = [
      {
        type: "model.streaming",
        payload: { kind: "reasoning_delta", delta: "思考中", assistantMessageId: "m1" },
      },
      {
        type: "model.streaming",
        payload: { kind: "text_delta", delta: "你好", assistantMessageId: "m1" },
      },
      {
        type: "tool.updated",
        payload: {
          kind: "scheduled",
          toolCallId: "tc1",
          toolName: "Bash",
          input: { command: "npm test" },
        },
      },
      {
        type: "tool.updated",
        payload: {
          kind: "result",
          toolCallId: "tc1",
          result: { text: "全部通过", exitCode: 0 },
          duration: 800,
        },
      },
      completedEvent("你好"),
    ];
    const runner = new ZcodeAgentRunner(makeGates([]), factoryFor(server).factory);
    const events = await collect(runner.run(task, baseOpts(), async () => ({ approved: true })));

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "session_init",
      "llm_input",
      "thinking_delta",
      "text_delta",
      "tool_use",
      "tool_result",
      "text",
      "llm_output",
      "result",
    ]);
    const toolUse = events.find((e) => e.type === "tool_use") as Extract<
      RunnerEvent,
      { type: "tool_use" }
    >;
    expect(toolUse.tool).toBe("Bash");
    expect(toolUse.toolUseId).toBe("tc1");
    const toolResult = events.find((e) => e.type === "tool_result") as Extract<
      RunnerEvent,
      { type: "tool_result" }
    >;
    expect(toolResult.content).toContain("全部通过");
    expect(toolResult.isError).toBe(false);
    const result = events[events.length - 1] as Extract<RunnerEvent, { type: "result" }>;
    expect(result.subtype).toBe("success");
    expect(result.result).toBe("你好");
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 0,
    });
  });

  it("turn.failed → result error（错误原文透传）", async () => {
    newWorkDir();
    const server = new FakeZcodeServer();
    server.eventsAfterSend = [
      {
        type: "turn.failed",
        payload: { error: { message: "Model request failed" }, turnPhase: "model_request" },
      },
    ];
    const runner = new ZcodeAgentRunner(makeGates([]), factoryFor(server).factory);
    const events = await collect(runner.run(task, baseOpts(), async () => ({ approved: true })));
    const result = events[events.length - 1] as Extract<RunnerEvent, { type: "result" }>;
    expect(result.subtype).toBe("error");
    expect(result.error).toBe("Model request failed");
  });

  it("守卫：白名单外工具 deny、shell git deny；门命中走审批卡并回写协议应答", async () => {
    newWorkDir();
    const server = new FakeZcodeServer();
    server.reverseOnSend = [
      // 白名单外（WebSearch 在 denylist，但假设直调权限通道）→ 白名单强制 deny
      {
        method: "interaction/requestPermission",
        params: { toolCallId: "tc-w", toolName: "WebSearch", input: { query: "x" } },
        answered: undefined,
      },
      // shell git → deny
      {
        method: "interaction/requestPermission",
        params: {
          toolCallId: "tc-git",
          toolName: "Bash",
          input: { command: "git push origin main" },
        },
        answered: undefined,
      },
      // 只读 Bash（GET 型 curl）→ 豁免审批门（不进门、不弹卡）
      {
        method: "interaction/requestPermission",
        params: {
          toolCallId: "tc-ls",
          toolName: "Bash",
          input: { command: "curl https://api.example.com/status" },
        },
        answered: undefined,
      },
      // 门命中（deploy）→ 弹审批卡；用户拒绝 → deny 回写
      {
        method: "interaction/requestPermission",
        params: { toolCallId: "tc-dep", toolName: "Bash", input: { command: "deploy now" } },
        answered: undefined,
      },
    ];
    server.eventsAfterSend = [completedEvent("ok")];
    const gates = makeGates([{ gateId: "deploy", toolName: "Bash" }]);

    const decisions: ApprovalDecision[] = [{ approved: false, reason: "不允许部署" }];
    const seenRequests: string[] = [];
    const resolver: ApprovalResolver = async (req) => {
      seenRequests.push(
        `${req.gateId}:${req.tool}:${String((req.input as { command?: string }).command ?? "")}`,
      );
      return decisions.shift() ?? { approved: true };
    };

    const runner = new ZcodeAgentRunner(gates, factoryFor(server).factory);
    await collect(runner.run(task, baseOpts(), resolver));

    const revs = server.reverseOnSend;
    const whitelisted = revs.at(0);
    const git = revs.at(1);
    const readOnly = revs.at(2);
    const deploy = revs.at(3);
    if (!whitelisted || !git || !readOnly || !deploy) throw new Error("reverse 脚本缺失");
    expect(whitelisted.answered).toMatchObject({ decision: "deny" });
    expect(String((whitelisted.answered as { reason?: string }).reason)).toContain("允许列表");
    expect(git.answered).toMatchObject({ decision: "deny" });
    expect(String((git.answered as { reason?: string }).reason)).toContain("donger-git");
    expect(readOnly.answered).toMatchObject({ decision: "allow" });
    expect(readOnly.answered).not.toHaveProperty("gateId");
    expect(deploy.answered).toMatchObject({ decision: "deny", reason: "不允许部署" });
    expect(seenRequests).toEqual(["deploy:Bash:deploy now"]);
  });

  it("full_access 豁免非 force 门；plan 模式（只读白名单）与 denylist 解析", async () => {
    newWorkDir();
    const server = new FakeZcodeServer();
    server.reverseOnSend = [
      {
        method: "interaction/requestPermission",
        params: { toolCallId: "tc-dep", toolName: "Bash", input: { command: "deploy now" } },
        answered: undefined,
      },
    ];
    server.eventsAfterSend = [completedEvent("ok")];
    const gates = makeGates([
      { gateId: "deploy", toolName: "Bash" },
      { gateId: "authoring", toolName: "Write", force: true },
    ]);
    (gates as { match: unknown }).match = (toolName: string, input: Record<string, unknown>) => {
      if (
        toolName === "Bash" &&
        typeof input.command === "string" &&
        input.command.includes("deploy")
      ) {
        return { gateId: "deploy" };
      }
      if (toolName === "Write") return { gateId: "authoring", force: true };
      return undefined;
    };
    const runner = new ZcodeAgentRunner(gates, factoryFor(server).factory);
    const _evs = await collect(
      (async function* () {
        for await (const e of runner.run(
          task,
          { ...baseOpts(), permissionMode: () => "full_access" },
          async () => ({ approved: true }),
        )) {
          yield e;
        }
      })(),
    );
    const fullAccessRev = server.reverseOnSend.at(0);
    if (!fullAccessRev) throw new Error("reverse 脚本缺失");
    expect(fullAccessRev.answered).toMatchObject({ decision: "allow" });

    // 只读白名单 → plan 模式；denylist = 词表 ∖ 白名单
    expect(resolveZcodeMode(["Read", "Glob", "Grep"])).toBe("plan");
    expect(resolveZcodeMode(["Read", "Edit"])).toBe("build");
    expect(resolveZcodeMode(undefined)).toBe("build");
    const denylist = resolveToolDenylist(["Read", "Write"]);
    expect(denylist).toContain("Bash");
    expect(denylist).not.toContain("Read");
    expect(denylist).not.toContain("Write");
    expect(resolveToolDenylist(undefined)).toBeUndefined();
  });

  it("runtimePreferences 应答关闭问询自动解析；userInput 桥接 donger 问询卡；plan_approval 拒绝", async () => {
    newWorkDir();
    const server = new FakeZcodeServer();
    let awaitingDuringAsk = false;
    server.reverseOnSend = [
      { method: "session/requestRuntimePreferences", params: {}, answered: undefined },
      {
        method: "interaction/requestUserInput",
        params: {
          toolCallId: "tc-q",
          questions: [
            {
              question: "选一个数据库",
              header: "存储",
              multiSelect: false,
              options: [
                { value: "sqlite", label: "SQLite" },
                { value: "pg", label: "PostgreSQL" },
              ],
            },
          ],
        },
        answered: undefined,
      },
      {
        method: "interaction/requestUserInput",
        params: {
          schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
          questions: [
            { question: "批准计划？", options: [{ value: "approve", label: "approve" }] },
          ],
        },
        answered: undefined,
      },
    ];
    server.eventsAfterSend = [completedEvent("ok")];
    const runner = new ZcodeAgentRunner(makeGates([]), factoryFor(server).factory);
    await collect(
      runner.run(
        task,
        {
          ...baseOpts(),
          questionResolver: async () => {
            awaitingDuringAsk = runner.isAwaitingUserInput(task.id);
            return { answers: { 选一个数据库: "PostgreSQL" } };
          },
        },
        async () => ({ approved: true }),
      ),
    );

    const revs2 = server.reverseOnSend;
    const prefs = revs2.at(0);
    const ask = revs2.at(1);
    const plan = revs2.at(2);
    if (!prefs || !ask || !plan) throw new Error("reverse 脚本缺失");
    expect(prefs.answered).toEqual({
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: false,
    });
    // 多选逗号串拆数组、choice 回 label；挂起期间看门狗豁免生效
    expect(ask.answered).toMatchObject({
      action: "accept",
      content: { answers: { 选一个数据库: "PostgreSQL" } },
    });
    expect(awaitingDuringAsk).toBe(true);
    expect(plan.answered).toMatchObject({ action: "decline" });
    expect(runner.isAwaitingUserInput(task.id)).toBe(false);
  });

  it("resume 走 session/resume；spawn/协议失败显性 error 不静默换引擎", async () => {
    const dir = newWorkDir();
    const server = new FakeZcodeServer();
    server.eventsAfterSend = [completedEvent("resumed")];
    const runner = new ZcodeAgentRunner(makeGates([]), factoryFor(server).factory);
    await collect(
      runner.run(task, { ...baseOpts(), resume: "sess_prev_1" }, async () => ({ approved: true })),
    );
    const resume = server.request("session/resume");
    expect(resume?.sessionId).toBe("sess_prev_1");
    expect(resume?.workspace).toEqual({ workspacePath: dir, workspaceKey: dir });

    const failing = new FakeZcodeServer();
    failing.failOnCreate = new Error("provider_not_found");
    const runner2 = new ZcodeAgentRunner(makeGates([]), factoryFor(failing).factory);
    const events = await collect(runner2.run(task, baseOpts(), async () => ({ approved: true })));
    const result = events[events.length - 1] as Extract<RunnerEvent, { type: "result" }>;
    expect(result.subtype).toBe("error");
    expect(result.error).toContain("provider_not_found");
  });

  it("契约 C2/C4：resume 轮 session_init/subscribe/send 全部对准干活 id（resume 目标）", async () => {
    newWorkDir();
    const server = new FakeZcodeServer();
    server.eventsAfterSend = [completedEvent("resumed")];
    const runner = new ZcodeAgentRunner(makeGates([]), factoryFor(server).factory);
    const events = await collect(
      runner.run(task, { ...baseOpts(), resume: "sess_prev_9" }, async () => ({ approved: true })),
    );
    // session_init 上报干活 id——指针回写/反查/对账全以此为准（create id 仅协议握手）
    const init = events.at(0) as Extract<RunnerEvent, { type: "session_init" }>;
    expect(init.sessionId).toBe("sess_prev_9");
    expect(server.request("session/subscribe")?.sessionId).toBe("sess_prev_9");
    expect(server.request("session/send")?.sessionId).toBe("sess_prev_9");
    // 订阅晚于 resume（会话激活是 subscribe 的前置）
    expect(server.requests.map((r) => r.method)).toEqual([
      "session/create",
      "session/resume",
      "session/subscribe",
      "session/send",
    ]);
  });

  it("契约 C5：send 后长时间零事件显性 fail（停摆守卫），不再无限挂死", async () => {
    newWorkDir();
    const server = new FakeZcodeServer();
    // 不回放任何事件：send 后永久静默（订阅错位/引擎挂死形态，2026-10-08 事故）
    const runner = new ZcodeAgentRunner(makeGates([]), factoryFor(server).factory);
    const prev = process.env.DONGER_ZCODE_EVENT_STALL_MS;
    process.env.DONGER_ZCODE_EVENT_STALL_MS = "80";
    try {
      const events = await collect(runner.run(task, baseOpts(), async () => ({ approved: true })));
      const result = events.at(-1) as Extract<RunnerEvent, { type: "result" }>;
      expect(result.subtype).toBe("error");
      expect(result.error).toContain("事件流停摆");
    } finally {
      if (prev === undefined) delete process.env.DONGER_ZCODE_EVENT_STALL_MS;
      else process.env.DONGER_ZCODE_EVENT_STALL_MS = prev;
    }
  });

  it("writeProviderConfig：个人 provider 注册形状（personalModelIds，禁 builtinModelIds）", () => {
    const dir = newWorkDir();
    const path = join(dir, "provider_config.json");
    writeProviderConfig(path, llm);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      schemaVersion: number;
      config: {
        providerConfigRules: {
          providerRules: Array<{ providerId: string; config: Record<string, unknown> }>;
        };
        modelConfigRules: Record<string, unknown[]>;
      };
    };
    expect(parsed.schemaVersion).toBe(1);
    const rule = parsed.config.providerConfigRules.providerRules.at(0);
    if (!rule) throw new Error("provider 规则缺失");
    expect(rule.providerId).toBe("donger-glm");
    expect(rule.config.personalModelIds).toEqual(["glm-4.6"]);
    expect(rule.config.builtinModelIds).toBeUndefined();
    expect(Object.keys(parsed.config.modelConfigRules)).toEqual([
      "providerModelRules",
      "manualProviderModelRules",
    ]);
  });

  it("MCP 桥级门语义：force 门任何模式拒、非 force 门 full_access 豁免、未命中放行", () => {
    const gates = makeGates([
      { gateId: "host-ops", toolName: "mcp__donger-host__exec", force: true },
      { gateId: "authoring", toolName: "mcp__donger-platform__create_asset", force: false },
    ]);
    const ask = createMcpGateCheck(gates, () => "ask_before_change");
    const full = createMcpGateCheck(gates, () => "full_access");
    expect(ask("mcp__donger-host__exec", {})).toEqual({ gateId: "host-ops", force: true });
    // force 门 full_access 不豁免（平台铁律）
    expect(full("mcp__donger-host__exec", {})).toEqual({ gateId: "host-ops", force: true });
    expect(ask("mcp__donger-platform__create_asset", {})).toEqual({
      gateId: "authoring",
      force: false,
    });
    // 非 force 门 full_access 豁免（与 claude canUseTool 同语义）
    expect(full("mcp__donger-platform__create_asset", {})).toBeUndefined();
    // 无门工具（kb_write 等）桥不拦——静态守卫在权限回调层
    expect(ask("mcp__donger-kb__kb_write", {})).toBeUndefined();
  });

  it("MCP 装配：进程内工具台经 HTTP 桥挂载 + 连接器透传，轮末按 run-token 卸载", async () => {
    newWorkDir();
    const server = new FakeZcodeServer();
    server.eventsAfterSend = [completedEvent("done")];
    const { factory } = factoryFor(server);
    const bridge = new McpHttpBridge("ZCode");
    const fakeSdkTools = (name: string) =>
      ({ name, instance: { connect: async () => {} } }) as never;
    const runner = new ZcodeAgentRunner(makeGates([]), factory, bridge);
    const opts = baseOpts({
      kbTools: fakeSdkTools("donger-kb"),
      hostTools: fakeSdkTools("donger-host"),
      mcpServers: [
        {
          name: "conn-stdio",
          type: "stdio",
          command: "node",
          args: ["srv.js"],
          env: { TOKEN: "t1" },
        },
        {
          name: "conn-http",
          type: "http",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer x" },
        },
      ],
    });

    await collect(runner.run(task, opts, async () => ({ approved: true })));

    const create = server.request("session/create");
    const mcp = create?.mcpServers as Array<Record<string, unknown>>;
    expect(mcp).toHaveLength(4);
    const kb = mcp.find((s) => s.name === "donger-kb");
    expect(kb?.type).toBe("http");
    expect(String(kb?.url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/.+\/donger-kb$/);
    expect(mcp.find((s) => s.name === "donger-host")).toBeTruthy();
    // 连接器透传为协议解析形状（env/headers 键值对数组）
    expect(mcp.find((s) => s.name === "conn-stdio")).toEqual({
      name: "conn-stdio",
      command: "node",
      args: ["srv.js"],
      env: [{ name: "TOKEN", value: "t1" }],
    });
    expect(mcp.find((s) => s.name === "conn-http")).toEqual({
      name: "conn-http",
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer x" }],
    });
    // 轮末卸载（per-run token）
    expect(bridge.mcpMountCountForTests()).toBe(0);
  });

  it("无工具台无连接器时 create 不带 mcpServers 键（白名单 agent 零开销路径不变）", async () => {
    newWorkDir();
    const server = new FakeZcodeServer();
    server.eventsAfterSend = [completedEvent("done")];
    const { factory } = factoryFor(server);
    const runner = new ZcodeAgentRunner(makeGates([]), factory);

    await collect(runner.run(task, baseOpts(), async () => ({ approved: true })));

    const create = server.request("session/create");
    expect(create?.mcpServers).toBeUndefined();
  });
});
