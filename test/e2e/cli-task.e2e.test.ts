// CLI ↔ 后端全链路 E2E（task 能力纵切）：
//   后端 = 真实 WebChannel（HTTP + SSE）+ Orchestrator + SQLite 存储 + kb 分发知识库；
//   CLI  = 真实 runChat REPL（in-process，stdin/stdout 注入流）+ 真实 createApi HTTP 客户端 + 真实 token exchange。
// runner 用脚本队列替换真实 LLM：dispatcher 出路由 JSON、执行轮出文本/工具行/挂起，其余全链路保真。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApi, type DongerApi } from "../../cli/src/api.js";
import { buildProgram } from "../../cli/src/commands.js";
import type { FakeScript } from "../../src/adapters/fake-agent-runner.js";
import { FakeAgentRunner } from "../../src/adapters/fake-agent-runner.js";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteAgentShareStore } from "../../src/adapters/sqlite-agent-share-store.js";
import { SqliteAgentStore } from "../../src/adapters/sqlite-agent-store.js";
import { SqliteAuditStore } from "../../src/adapters/sqlite-audit-store.js";
import { SqliteCommentStore } from "../../src/adapters/sqlite-comment-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteCredentialSetStore } from "../../src/adapters/sqlite-credential-set-store.js";
import { SqliteMessageStore } from "../../src/adapters/sqlite-message-store.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import { SqliteTaskStore } from "../../src/adapters/sqlite-task-store.js";
import { SqliteTranscriptStore } from "../../src/adapters/sqlite-transcript-store.js";
import { SqliteUsageStore } from "../../src/adapters/sqlite-usage-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import type { Agent } from "../../src/domain/agent.js";
import type { RunnerEvent, Task } from "../../src/domain/types.js";
import { createDefaultGates } from "../../src/orchestrator/default-gates.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { RuntimeManager } from "../../src/orchestrator/runtime-manager.js";
import type { AgentRunner, ApprovalResolver, RunOptions } from "../../src/ports/agent-runner.js";
import type { SkillInstaller } from "../../src/ports/skill-installer.js";
import { loadOrGenerateAppSecret } from "../../src/util/app-secret.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";
import { ChatDriver } from "./helpers/driver.js";

const CLI_TOKEN = "e2e-cli-token";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// E2E 走真实 HTTP+SSE 多轮交互，默认 5s 超时不够
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

//#region 脚本 runner：dispatcher / 执行轮逐个出牌；hang 脚本挂起直到 abort（模拟长任务）
type Script = FakeScript & { hang?: boolean };

class QueueRunner implements AgentRunner {
  readonly scripts: Script[] = [];
  /** 每轮收到的 prompt（断言 dispatcher JSON / 驳回修订 prompt 用） */
  readonly prompts: string[] = [];
  private n = 0;

  async *run(task: Task, opts: RunOptions, resolver: ApprovalResolver): AsyncIterable<RunnerEvent> {
    this.prompts.push(task.prompt);
    const script = this.scripts.shift() ?? { result: "(脚本耗尽)" };
    if (script.hang) {
      await new Promise<void>((resolve) => {
        if (opts.abortSignal?.aborted) resolve();
        else opts.abortSignal?.addEventListener("abort", () => resolve());
      });
      return;
    }
    this.n += 1;
    yield { type: "session_init", taskId: task.id, sessionId: `sdk-${this.n}` };
    yield* new FakeAgentRunner(script).run(task, opts, resolver);
  }
}
//#endregion

//#endregion

//#region 后端装配：真实 WebChannel + Orchestrator + SQLite，仅 runner 脚本化
interface Backend {
  baseUrl: string;
  runner: QueueRunner;
  channel: WebChannel;
  agent: Agent;
  dir: string;
}

async function startBackend(): Promise<Backend> {
  const dir = mkdtempSync(join(tmpdir(), "donger-cli-e2e-"));
  const db = new Database(":memory:");
  const store = new SqliteTaskStore(db);
  store.migrate();
  const usersDir = join(dir, "users");
  mkdirSync(usersDir, { recursive: true });
  const userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
  userStore.migrate();
  const conversationStore = new SqliteConversationStore(db);
  conversationStore.migrate();
  const messageStore = new SqliteMessageStore(db);
  messageStore.migrate();
  const usageStore = new SqliteUsageStore(db);
  usageStore.migrate();
  const auditStore = new SqliteAuditStore(db);
  auditStore.migrate();
  const commentStore = new SqliteCommentStore(db);
  commentStore.migrate();
  const transcriptStore = new SqliteTranscriptStore(db);
  transcriptStore.migrate();
  const sessionStore = new JwtSessionStore(db, "e2e-jwt-secret", 24 * 60 * 60 * 1000);
  sessionStore.migrate();
  const skillPackStore = new SqliteSkillPackStore(db);
  skillPackStore.migrate();
  const credentialSets = new SqliteCredentialSetStore(
    db,
    loadOrGenerateAppSecret(db, "skill_secret_key"),
  );
  credentialSets.migrate();
  const agentStore = new SqliteAgentStore(db, createSecretCipher("e2e-seed"));
  agentStore.migrate();
  const agentShareStore = new SqliteAgentShareStore(db);
  agentShareStore.migrate();

  const user = await userStore.getOrCreateByIdentity("internal", "cli-admin", "cli-admin");
  const agent = await agentStore.create({
    ownerId: user.id,
    name: "e2e-executor",
    description: "E2E 演示执行智能体",
    skills: ["demo-execute"],
    tools: { mode: "all", whitelist: [] },
    mcpServers: [],
    llm: {},
  });

  const installer: SkillInstaller = {
    installFromGit: async () => ({}) as never,
    installFromUpload: async () => ({}) as never,
    installFromPaste: async () => ({}) as never,
    installBuiltin: async () => ({}) as never,
    uninstall: async () => {},
    update: async () => ({}) as never,
  };
  const runtimeMgr = new RuntimeManager({
    transcriptStore,
    conversationStore,
    config: {
      workspaceDir: dir,
      llm: { model: "e2e-fake", baseUrl: "http://127.0.0.1:9", authToken: "x" },
      defaultSystemPromptAppend: "",
      agentLlmPresets: [],
    },
    skillPackStore,
    credentialSets,
    installer,
    builtinSkillsDir: "",
  });

  const runner = new QueueRunner();
  const channel = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: dir,
    taskStore: store,
    userStore,
    conversationStore,
    messageStore,
    usageStore,
    auditStore,
    commentStore,
    sessionStore,
    cliToken: CLI_TOKEN,
    agentStore,
    agentShareStore,
  });
  const orch = new Orchestrator({
    store,
    userStore,
    conversationStore,
    messageStore,
    usageStore,
    auditStore,
    commentStore,
    gates: createDefaultGates(),
    runner,
    channel,
    runtimeMgr,
    credentialSets,
    agentStore,
    agentShareStore,
    installer,
    skillPackStore,
  });
  channel.onMessage((m) => void orch.handleMessage(m));
  channel.onCancel((conversationId) => orch.cancelConversation(conversationId));
  await channel.ready();

  const baseUrl = `http://127.0.0.1:${channel.boundPort}`;
  return { baseUrl, runner, channel, agent, dir };
}
//#endregion

describe("CLI task 能力 E2E（真实 HTTP+SSE 后端）", () => {
  let backend: Backend;
  let api: DongerApi;
  let jwt: string;

  beforeAll(async () => {
    backend = await startBackend();
    const boot = createApi(backend.baseUrl, "");
    const { token } = await boot.exchange(CLI_TOKEN);
    jwt = token;
    api = createApi(backend.baseUrl, token);
  });

  afterAll(async () => {
    await Promise.race([backend.channel.stop(), sleep(2000)]);
    rmSync(backend.dir, { recursive: true, force: true });
  });

  function dispatcher(agentId: string, requiresDesign = false): Script {
    return {
      result: `{"agentId":"${agentId}","requiresDesign":${requiresDesign},"taskType":"e2e-demo","rationale":"登记表匹配演示智能体"}`,
    };
  }

  it("分发 → 执行 → done 全链路，/tasks 列表与 /result 详情可用", async () => {
    backend.runner.scripts.push(dispatcher(backend.agent.id), {
      intro: "开始处理",
      toolCalls: [{ tool: "Read", input: { path: "a.md" }, toolUseId: "t1", result: "ok" }],
      outro: "周报已生成",
      result: "周报已生成",
    });
    const cli = await ChatDriver.start(api, backend.baseUrl, jwt);
    cli.type("帮我把仓库里的报告汇总成周报");

    // 分派反馈 + 工具活动行 + 完成标记 + 产物衔接提示
    await cli.see("📨 已分派给「e2e-executor」");
    await cli.see("📖 Read");
    await cli.see("周报已生成");
    await cli.see("✅ 完成");
    await cli.see("💡 tasks files");

    // /tasks 列表：done 任务可见，带 phase 与 prompt 摘要
    cli.type("/tasks");
    await cli.see("done");
    await cli.see("帮我把仓库里的报告汇总成周报");

    // /tasks <id前缀> 详情 + /result 只看结果
    const id8 = cli.taskShortId();
    expect(id8).toBeDefined();
    cli.type(`/tasks ${id8}`);
    await cli.see(`任务 ${id8}`);
    cli.type(`/result ${id8}`);
    await cli.see("周报已生成");

    await cli.exit();
  }, 60_000);

  it("闲聊兜底：taskType=chat 直答，不走分发", async () => {
    backend.runner.scripts.push(
      {
        result: '{"agentId":"none","requiresDesign":false,"taskType":"chat","rationale":"打招呼"}',
      },
      // 回答以 text 事件输出（真实 LLM 行为）；result 只承载回合终态
      { intro: "你好呀，我是兜底直答", result: "你好呀，我是兜底直答" },
    );
    const cli = await ChatDriver.start(api, backend.baseUrl, jwt);
    cli.type("你好");
    await cli.see("你好呀，我是兜底直答");
    expect(cli.out.includes("📨")).toBe(false);
    await cli.exit();
  }, 60_000);

  it("方案门驳回→修订→批准→验收门→done 全生命周期（含 thinking 透出）", async () => {
    backend.runner.scripts.push(
      dispatcher(backend.agent.id, true),
      { thinking: "先理解需求，再定方案边界…", result: "方案 v1：先做 A" },
      { result: "方案 v2：先做 B" },
      { result: "已按方案执行完毕" },
    );
    const cli = await ChatDriver.start(api, backend.baseUrl, jwt);
    cli.type("给项目加一个导出功能");

    await cli.see("📋 方案设计阶段");
    await cli.see("💭"); // 思考流实时透出（V17）
    await cli.see("先理解需求，再定方案边界…");
    await cli.see("🔔 审批门：方案设计确认");
    await cli.see("方案 v1：先做 A"); // 卡片摘要可见
    cli.type("n"); // 驳回
    await cli.see("驳回原因"); // 非 TTY 下提示回显，驱动可同步
    cli.type("范围太大");
    await cli.see("方案 v2：先做 B"); // 修订后再次出方案
    expect(backend.runner.prompts.some((p) => p.includes("方案被驳回：范围太大"))).toBe(true);
    cli.type("y"); // 批准修订方案
    await cli.see("🔨 执行阶段");
    await cli.see("🔔 审批门：验收确认");
    await cli.see("已按方案执行完毕"); // 验收卡摘要可见
    cli.type("y");
    await cli.see("✅ 完成");
    await cli.exit();
  }, 60_000);

  it("/cancel 中断运行中任务，canceled 任务在 /tasks 可见", async () => {
    backend.runner.scripts.push(dispatcher(backend.agent.id), { hang: true });
    const cli = await ChatDriver.start(api, backend.baseUrl, jwt);
    cli.type("跑一个长任务");
    await cli.see("📨 已分派给");
    cli.type("/cancel");
    await cli.see("已停止生成");

    cli.type("/tasks");
    await cli.see("canceled");
    await cli.exit();
  }, 60_000);

  it("运行中输入排队：斜杠命令按命令执行、不作为聊天消息发送", async () => {
    backend.runner.scripts.push(dispatcher(backend.agent.id), { hang: true });
    const cli = await ChatDriver.start(api, backend.baseUrl, jwt);
    cli.type("跑一个长任务");
    await cli.see("📨 已分派给");

    // 任务运行中：/tasks 应作为命令排队（回合结束后执行），/cancel 立即生效
    cli.type("/tasks");
    await cli.see("已排队，当前任务完成后自动处理");
    cli.type("/cancel");
    await cli.see("已停止生成");
    // 回合结束后排队的 /tasks 被执行（显示 canceled 任务），而非把字面 "/tasks" 发给后端当聊天
    await cli.see("canceled");
    expect(cli.out.match(/📨/g)?.length ?? 0).toBe(1); // 只有首轮分派，没有第二轮聊天分发
    await cli.exit();
  }, 60_000);

  it("工具规则门（deploy）：批准后继续执行", async () => {
    backend.runner.scripts.push(dispatcher(backend.agent.id), {
      intro: "准备部署",
      gate: {
        gateId: "deploy",
        tool: "Bash",
        input: { command: "deploy prod" },
        summary: "即将执行 deploy prod",
      },
      outro: "部署完成",
      result: "部署完成",
    });
    const cli = await ChatDriver.start(api, backend.baseUrl, jwt);
    cli.type("部署到生产环境");
    await cli.see("📨 已分派给");
    await cli.see("🔔 审批门：部署/发布/推送操作审批");
    await cli.see("即将执行 deploy prod");
    cli.type("y");
    await cli.see("部署完成");
    await cli.see("✅ 完成");
    await cli.exit();
  }, 60_000);

  it("工具规则门驳回：任务失败且失败原因回显", async () => {
    backend.runner.scripts.push(dispatcher(backend.agent.id), {
      intro: "准备部署",
      gate: {
        gateId: "deploy",
        tool: "Bash",
        input: { command: "deploy prod" },
        summary: "即将执行 deploy prod",
      },
      result: "不应到达",
    });
    const cli = await ChatDriver.start(api, backend.baseUrl, jwt);
    cli.type("部署到生产环境");
    await cli.see("🔔 审批门：部署/发布/推送操作审批");
    cli.type("n");
    await cli.see("驳回原因");
    cli.type("窗口期不让部署");
    await cli.see("❌ 失败：窗口期不让部署");
    await cli.see("❌ 任务失败");
    await cli.exit();
  }, 60_000);

  it("管理命令族：tasks list --json 与 tasks result（命令入口直跑）", async () => {
    // 先经 chat 造一个 done 任务
    backend.runner.scripts.push(dispatcher(backend.agent.id), {
      intro: "开始处理",
      outro: "命令族回看输出",
      result: "命令族回看输出",
    });
    const cli = await ChatDriver.start(api, backend.baseUrl, jwt);
    cli.type("跑一个供回看的任务");
    await cli.see("✅ 完成");
    const id8 = cli.taskShortId();
    await cli.exit();
    expect(id8).toBeDefined();

    // 进程内直跑命令入口：真实 commander + profile 加载（临时 HOME）+ HTTP api，
    // 仅省去进程隔离（Windows 下 spawn tsx 冷启动慢且脆）。
    const home = mkdtempSync(join(tmpdir(), "donger-cli-home-"));
    mkdirSync(join(home, ".donger"), { recursive: true });
    writeFileSync(
      join(home, ".donger", "cli.json"),
      JSON.stringify({ baseUrl: backend.baseUrl, token: jwt }),
      "utf8",
    );
    const prev = {
      home: process.env.HOME,
      userProfile: process.env.USERPROFILE,
      exitCode: process.exitCode,
    };
    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...v: unknown[]): void => {
      captured.push(v.map(String).join(" "));
    };
    const runCommand = async (label: string, args: string[]): Promise<void> => {
      captured.length = 0;
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      console.error(`[mark] before ${label}`);
      try {
        // from:"user" —— 否则 commander 把首参当脚本名，落到默认 chat 命令（挂起等 stdin）
        await buildProgram().exitOverride().parseAsync(args, { from: "user" });
        console.error(`[mark] after ${label}`);
      } finally {
        process.env.HOME = prev.home;
        process.env.USERPROFILE = prev.userProfile;
      }
    };
    try {
      await runCommand("list", ["tasks", "list", "--json"]);
      const rows = JSON.parse(captured.join("")) as Array<{ id: string; status: string }>;
      const doneTask = rows.find((t) => t.id.startsWith(id8!));
      expect(doneTask?.status).toBe("done");

      // tasks result <id> 需完整 id（chat 内 /result 支持前缀，命令族按精确 id）
      await runCommand("result", ["tasks", "result", doneTask?.id]);
      expect(captured.join("")).toContain("命令族回看输出");
    } finally {
      console.log = origLog;
      process.exitCode = prev.exitCode;
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});
