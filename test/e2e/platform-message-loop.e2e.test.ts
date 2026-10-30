import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RobotTextMessage } from "dingtalk-stream";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteAgentStore } from "../../src/adapters/sqlite-agent-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteCredentialSetStore } from "../../src/adapters/sqlite-credential-set-store.js";
import { SqliteEventFiringStore } from "../../src/adapters/sqlite-event-firing-store.js";
import { SqliteEventStore } from "../../src/adapters/sqlite-event-store.js";
import { SqliteMessageStore } from "../../src/adapters/sqlite-message-store.js";
import { SqliteModuleConfigStore } from "../../src/adapters/sqlite-module-config-store.js";
import { SqliteNotificationStore } from "../../src/adapters/sqlite-notification-store.js";
import { SqliteTaskStore } from "../../src/adapters/sqlite-task-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { SqliteWorkflowRunStore } from "../../src/adapters/sqlite-workflow-run-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import { DingTalkChannel } from "../../src/adapters/dingtalk-channel.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { InMemoryUsageStore } from "../../src/adapters/in-memory-usage-store.js";
import { NotificationService } from "../../src/orchestrator/notification-service.js";
import { EventDispatcher } from "../../src/orchestrator/event-dispatcher.js";
import { MessageEventRouter } from "../../src/orchestrator/message-event-router.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { RuntimeManager } from "../../src/orchestrator/runtime-manager.js";
import { createDefaultGates } from "../../src/orchestrator/default-gates.js";
import { createTaskComment } from "../../src/util/teambition-api.js";
import { FakeAgentRunner } from "../../src/adapters/fake-agent-runner.js";
import type { RobotTextMessage as Rtm } from "dingtalk-stream";
import type { RunnerEvent, Task } from "../../src/domain/types.js";
import type { AgentRunner, ApprovalResolver, RunOptions } from "../../src/ports/agent-runner.js";
import { loadOrGenerateAppSecret } from "../../src/util/app-secret.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

/**
 * 平台消息闭环 e2e（spec 2026-10-27-platform-message-subscription-design §6 验收清单）：
 * 真实 DingTalkChannel（SDK mock 注入回调）+ WebChannel + MessageEventRouter + EventDispatcher +
 * 真实 Orchestrator（Fake runner 脚本化 LLM）+ 真实存储；钉钉群发/单聊、TB 评论出站全 stub 并断言。
 * 覆盖：钉钉群 @ 全链（fire→run→写手→群回复+站内信）、非白名单不触发不聊天、eventId 去重、
 * TB webhook 验签 fail-closed/From-Me 防环/全链评论回写、手动运行无锚降级 inapp。
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const OWNER_EXTERNAL = "pml-owner";
const GROUP_CID = "cid-group-e2e";
const WRITER_TEXT = "通知成稿：master 最新提交是 abc1234（已确认）";

const outbound = {
  groupSends: [] as Array<{ body: Record<string, unknown> }>,
  singleSends: [] as Array<{ userIds: unknown }>,
  tbComments: [] as Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }>,
};

const realFetch = globalThis.fetch;
async function stubFetch(url: string, init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (u.includes("127.0.0.1") || u.includes("localhost")) return realFetch(url, init);
  const json = (): Record<string, unknown> => {
    try {
      return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  if (u.includes("oapi.dingtalk.com/gettoken")) {
    return Response.json({ access_token: "tok-e2e", expires_in: 7200 });
  }
  if (u.includes("/robot/groupMessages/send")) {
    outbound.groupSends.push({ body: json() });
    return Response.json({ errcode: 0 });
  }
  if (u.includes("/robot/oToMessages/batchSend")) {
    outbound.singleSends.push({ userIds: json().userIds });
    return Response.json({ errcode: 0 });
  }
  if (u.includes("open.teambition.com/api/v3/task/") && u.endsWith("/comment")) {
    outbound.tbComments.push({
      url: u,
      body: json(),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return Response.json({ dynamic: { id: "dyn-e2e" } });
  }
  throw new Error(`e2e-stub-fetch 未覆盖的出站: ${u}`);
}

let robotCallback: ((msg: { data: string; headers: { messageId: string } }) => Promise<void>) | null =
  null;
vi.mock("dingtalk-stream", async (importOriginal) => {
  const orig = await importOriginal<typeof import("dingtalk-stream")>();
  return {
    ...orig,
    DWClient: class {
      registerCallbackListener(_topic: string, cb: never) {
        robotCallback = cb as never;
        return this;
      }
      socketCallBackResponse = vi.fn();
      async connect(): Promise<void> {}
      disconnect(): void {}
    },
  };
});

let db: Database.Database;
let web: WebChannel;
let dispatcher: EventDispatcher;
let dtChannel: DingTalkChannel;
let notificationStore: SqliteNotificationStore;
let eventRowId: string;
let workflowId: string;
let workspace = "";
let msgSeq = 0;

function groupRobot(msgId: string, staffId: string, text: string): Rtm {
  return {
    conversationId: GROUP_CID,
    chatbotCorpId: "c",
    chatbotUserId: "b",
    msgId,
    senderNick: "张三",
    isAdmin: false,
    senderStaffId: staffId,
    sessionWebhookExpiredTime: 0,
    createAt: Date.now(),
    senderCorpId: "sc",
    conversationType: "2",
    senderId: staffId,
    sessionWebhook: "https://sw",
    robotCode: "rc",
    msgtype: "text",
    text: { content: `@机器人 ${text}` },
  };
}

const waitFor = async <T>(fn: () => T | undefined, timeoutMs = 30_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 60));
  }
};

beforeAll(async () => {
  vi.stubGlobal("fetch", vi.fn(stubFetch as typeof fetch));
  workspace = mkdtempSync(join(tmpdir(), "donger-pml-e2e-"));
  db = new Database(":memory:");
  const cipher = createSecretCipher("e2e-pw");

  const userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir: workspace });
  userStore.migrate();
  const agentStore = new SqliteAgentStore(db, cipher);
  agentStore.migrate();
  const conversationStore = new SqliteConversationStore(db);
  conversationStore.migrate();
  const messageStore = new SqliteMessageStore(db);
  messageStore.migrate();
  const eventStore = new SqliteEventStore(db);
  eventStore.migrate();
  const firingStore = new SqliteEventFiringStore(db);
  firingStore.migrate();
  const workflowStore = new SqliteWorkflowStore(db);
  workflowStore.migrate();
  const runStore = new SqliteWorkflowRunStore(db);
  runStore.migrate();
  taskStoreProxy.target = new SqliteTaskStore(db);
  taskStoreProxy.target.migrate?.();
  notificationStore = new SqliteNotificationStore(db);
  notificationStore.migrate();
  const moduleConfigStore = new SqliteModuleConfigStore(db, "a".repeat(64));
  moduleConfigStore.migrate();
  moduleConfigStore.putTeambition({ appKey: "tb-app", appSecret: "tb-secret", orgId: "org-1" });

  const notifications = new NotificationService({ store: notificationStore, retryDelaysMs: [0, 0] });
  const credentialSets = SqliteCredentialSetStore.fromSeed(
    db,
    loadOrGenerateAppSecret(db, "skill_secret_key"),
  );
  credentialSets.migrate?.();

  // 用户：owner（local 身份，取真实 id）+ 两个钉钉群成员
  const owner = await userStore.getOrCreateByIdentity("local", OWNER_EXTERNAL, "pml-owner");
  await userStore.getOrCreateByIdentity("dingtalk", "staff-1", "张三");
  await userStore.getOrCreateByIdentity("dingtalk", "staff-2", "李四");

  const runner = new FakeAgentRunner({ intro: WRITER_TEXT, result: WRITER_TEXT });
  const seenEvents: string[] = [];
  const runnerSpy: AgentRunner = {
    async *run(task: Task, opts: RunOptions, resolver: ApprovalResolver): AsyncIterable<RunnerEvent> {
      for await (const e of runner.run(task, opts, resolver)) {
        seenEvents.push(e.type + (e.type === 'text' ? ':' + String((e as { text?: string }).text).slice(0, 40) : ''));
        yield e;
      }
    },
  };

  const execAgent = await agentStore.create({
    ownerId: owner.id,
    name: "pml-exec",
    description: "e2e 执行",
    skills: [],
    tools: { mode: "all", whitelist: [] },
    connectorIds: [],
    credentials: [],
    gitRepositories: [],
  } as never);
  const writerAgent = await agentStore.create({
    ownerId: owner.id,
    name: "pml-writer",
    description: "e2e 写手",
    skills: [],
    tools: { mode: "all", whitelist: [] },
    connectorIds: [],
    credentials: [],
    gitRepositories: [],
  } as never);

  dtChannel = new DingTalkChannel({ appKey: "k", appSecret: "s", robotCode: "rc" });

  const runtimeMgr = new RuntimeManager({
    transcriptStore: {
      async append() {},
      async load() {
        return null;
      },
      async listSessions() {
        return [];
      },
      async latestSessionForConversation() {
        return null;
      },
      async listSubkeys() {
        return [];
      },
      async delete() {},
    },
    conversationStore,
    config: {
      workspaceDir: workspace,
      llm: { model: "m", baseUrl: "u", authToken: "t" },
      defaultSystemPromptAppend: "e2e",
      agentLlmPresets: [],
    },
    skillPackStore: {
      listEnabled: async () => [],
      listPacks: async () => [],
      listSkills: async () => [],
    } as never,
    credentialSets: credentialSets,
    installer: {
      installFromGit: async () => ({}) as never,
      installFromUpload: async () => ({}) as never,
      installFromPaste: async () => ({}) as never,
      installBuiltin: async () => ({}) as never,
      uninstall: async () => {},
      update: async () => ({}) as never,
      readSkillDoc: async () => ({}) as never,
      updateSkillDoc: async () => ({}) as never,
    },
    builtinSkillsDir: "",
  });
  const mkOrch = (channel: unknown) =>
    new Orchestrator({
      store: taskStoreProxy.target as never,
      userStore,
      conversationStore,
      usageStore: new InMemoryUsageStore(),
      auditStore: new InMemoryAuditStore(),
      gates: createDefaultGates(),
      runner: runnerSpy,
      channel: channel as never,
      runtimeMgr,
      agentStore,
      credentialSets,
      messageStore,
    });
  // TB 订阅 + 工作流（webhook 事件→评论回写）
  const tbEvent = await eventStore.create({
    ownerId: owner.id,
    name: "TB 任务事件订阅",
    type: "message",
    message: {
      platform: "teambition",
      topic: "task.update",
      filter: { orgId: "org-1" },
    },
  } as never);
  await workflowStore.create({
    ownerId: owner.id,
    name: "TB 任务处理",
    eventId: tbEvent.id,
    agentId: execAgent.id,
    promptTemplate: "处理 TB 任务事件：{{triggerOutput}}",
    enabled: true,
    permissionMode: "full_access",
    notifyPolicy: {
      enabled: true,
      on: ["success"],
      writerAgentId: writerAgent.id,
      recipients: "owner",
      channels: ["source", "inapp"],
    },
  } as never);

  // webDeps 持引用晚绑（teambitionRouter 在 router 创建后回填，同 setSystemEventSink 时序）
  const webDeps: import("../../src/adapters/web-channel.js").WebChannelDeps = {
    port: 0,
    host: "127.0.0.1",
    workspaceDir: workspace,
    sessionStore: new JwtSessionStore(db, "pml-e2e"),
    userStore,
    moduleConfigStore,
    teambitionEnabled: () => true,
  };
  web = new WebChannel(webDeps);
  web.onMessage(() => {});
  await web.ready();

  // 双编排器（对齐 prod 装配）：web 通道跑 dispatcher/通知轮，钉钉通道跑群消息对话
  const orchWeb = mkOrch(web);
  const orchDt = mkOrch(dtChannel);
  dtChannel.onMessage((m) => void orchDt.handleMessage(m));

  dispatcher = new EventDispatcher({
    eventStore,
    workflowStore,
    runStore,
    firingStore,
    messageStore,
    orchestrator: orchWeb,
    conversationStore,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    notifications,
    sourceDeliver: async (anchor, text) => {
      if (anchor.platform === "dingtalk") {
        await dtChannel.send(anchor.threadId, { text, markdown: true });
        return;
      }
      if (anchor.platform === "teambition") {
        await createTaskComment(
          { appKey: "tb-app", appSecret: "tb-secret", orgId: "org-1" },
          anchor.taskId,
          text,
        );
        return;
      }
      throw new Error("不支持的平台");
    },
  });

  const router = new MessageEventRouter({ eventStore, dispatcher });
  dtChannel.onGroupMessage((envelope) => router.route(envelope).then((r) => r.consumed));
  webDeps.teambitionRouter = router;

  const event = await eventStore.create({
    ownerId: owner.id,
    name: "群消息订阅",
    type: "message",
    message: {
      platform: "dingtalk",
      topic: "robot.group",
      filter: { allowFrom: ["staff-1"] },
    },
  } as never);
  eventRowId = event.id;
  const workflow = await workflowStore.create({
    ownerId: owner.id,
    name: "群消息处理",
    eventId: event.id,
    agentId: execAgent.id,
    promptTemplate: "处理群消息：{{triggerOutput}}",
    enabled: true,
    permissionMode: "full_access",
    notifyPolicy: {
      enabled: true,
      on: ["success"],
      writerAgentId: writerAgent.id,
      recipients: "owner",
      channels: ["source", "inapp"],
    },
  } as never);
  workflowId = workflow.id;

});

/** 任务存储晚绑（Orchestrator 构造前赋值；与 setSystemEventSink 同款时序） */
const taskStoreProxy: { target: SqliteTaskStore | null } = { target: null };

afterAll(async () => {
  await web.stop();
  db.close();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function deliverRobot(msg: Rtm): Promise<void> {
  msgSeq += 1;
  await robotCallback?.({ data: JSON.stringify(msg), headers: { messageId: `m-${msgSeq}` } });
}

async function countFirings(): Promise<number> {
  const rows = await (dispatcher as unknown as {
    deps: {
      firingStore: { listByEvent: (id: string, o?: { limit?: number }) => Promise<unknown[]> };
    };
  }).deps.firingStore.listByEvent(eventRowId, { limit: 200 });
  return rows.length;
}

async function listRuns(): Promise<Array<{ kind: string; status: string; conversationId?: string | null }>> {
  return (dispatcher as unknown as {
    deps: {
      runStore: { listRuns: (id: string, o: object) => Promise<Array<{ kind: string; status: string }>> };
    };
  }).deps.runStore.listRuns(workflowId, { limit: 50 });
}

describe("平台消息闭环 e2e（spec §6 验收清单）", () => {
  afterEach(() => {
    outbound.groupSends.length = 0;
    outbound.singleSends.length = 0;
    outbound.tbComments.length = 0;
  });

  it("验收1 钉钉群 @ 全链：白名单成员 → fire → run → 写手 → 群回复 + 站内信", async () => {
    await deliverRobot(groupRobot(`msg-ok-${Date.now()}`, "staff-1", "查下 master 最新提交"));

    // firing 记录（source=message）+ 业务轮与通知轮全部 success
    const firing = await waitFor(async () => {
      const rows = await (dispatcher as unknown as {
        deps: {
          firingStore: { listByEvent: (id: string) => Promise<Array<{ source: string; matchedWorkflowCount: number }>> };
        };
      }).deps.firingStore.listByEvent(eventRowId);
      return rows.find((r) => r.source === "message" && r.matchedWorkflowCount === 1);
    });
    expect(firing).toBeDefined();
    const runs = await waitFor(async () => {
      const rs = await listRuns();
      const business = rs.find((x) => x.kind === "workflow");
      const notify = rs.find((x) => x.kind === "notify");
      return business?.status === "success" && notify?.status === "success" ? rs : undefined;
    });
    expect(runs).toBeDefined();

    // 群回复：groupMessages/send 回群（markdown，含写手成稿）
    const groupSend = await waitFor(() => outbound.groupSends[0]);
    expect(groupSend.body.openConversationId).toBe(GROUP_CID);
    expect(groupSend.body.msgKey).toBe("sampleMarkdown");
    expect(String(groupSend.body.msgParam)).toContain(WRITER_TEXT);
    // 单聊未卷入（回源到群而非错投私聊）
    expect(outbound.singleSends.length).toBe(0);

    // 站内信同达（source 请求强制补 inapp）
    const inapp = await waitFor(() =>
      db
        .prepare("SELECT count(*) AS n FROM notifications WHERE userId IN (SELECT id FROM users) AND event='workflow.result_notified'")
        .get() as unknown as { n: number },
    );
    expect(inapp.n).toBeGreaterThanOrEqual(1);
  });

  it("验收4a 非白名单成员 @ → 消费但不触发、不聊天", async () => {
    const firingsBefore = await countFirings();
    await deliverRobot(groupRobot(`msg-deny-${Date.now()}`, "staff-2", "我也想查"));
    await new Promise((r) => setTimeout(r, 600));
    expect(await countFirings()).toBe(firingsBefore);
    expect(outbound.singleSends.length).toBe(0);
  });

  it("验收5a 同 eventId 重推 → 去重只跑一轮", async () => {
    const firingsBefore = await countFirings();
    const dup = groupRobot("msg-dup-fixed", "staff-1", "重复推送");
    await deliverRobot(dup);
    await waitFor(async () => (await countFirings()) > firingsBefore);
    const afterFirst = await countFirings();
    await deliverRobot(dup);
    await new Promise((r) => setTimeout(r, 600));
    expect(await countFirings()).toBe(afterFirst);
  });

  it("验收3+4b TB webhook：验签 401 / From-Me 防环 / 全链评论回写", async () => {
    const port = web.boundPort!;
    const tbBody = JSON.stringify({
      orgId: "org-1",
      timestamp: Date.now(),
      event: "task.update",
      eventId: `evt-${Date.now()}`,
      data: {
        operatorId: "member-7",
        task: { taskId: "task-e2e-1", projectId: "proj-1", content: "上线前回归" },
      },
    });
    const sig = createHmac("sha256", "tb-secret").update(tbBody).digest("hex");

    expect((await tbPost(port, tbBody, { "x-signature": "deadbeef" })).status).toBe(401);

    const fromMe = await tbPost(port, tbBody, { "x-signature": sig, "x-trigger-from-me": "true" });
    expect(fromMe.status).toBe(200);
    expect(((await fromMe.json()) as { skipped?: string }).skipped).toBe("self-triggered");

    const commentsBefore = outbound.tbComments.length;
    const res = await tbPost(port, tbBody, { "x-signature": sig });
    expect(res.status).toBe(200);
    const comment = await waitFor(() => outbound.tbComments[outbound.tbComments.length - 1]);
    expect(outbound.tbComments.length).toBeGreaterThan(commentsBefore);
    expect(comment.url).toContain("/api/v3/task/task-e2e-1/comment");
    expect(comment.headers["X-Tenant-Id"]).toBe("org-1");
    expect(comment.headers.Authorization).toMatch(/^Bearer /);
    expect(String(comment.body.content)).toContain(WRITER_TEXT);
  });

  it("验收2 手动运行（无锚）→ source 降级：不回源、站内信唯一送达", async () => {
    const groupBefore = outbound.groupSends.length;
    const commentsBefore = outbound.tbComments.length;
    await dispatcher.manualRun(workflowId, { payload: "普通文本载荷（无锚点）" });
    const notify = await waitFor(async () => {
      const rs = await listRuns();
      const rows = rs.filter((x) => x.kind === "notify");
      return rows[rows.length - 1]?.status === "success" ? rows[rows.length - 1] : undefined;
    });
    expect(notify).toBeDefined();
    await new Promise((r) => setTimeout(r, 400));
    expect(outbound.groupSends.length).toBe(groupBefore);
    expect(outbound.tbComments.length).toBe(commentsBefore);
  });
});

function tbPost(port: number, body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/webhooks/teambition`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

