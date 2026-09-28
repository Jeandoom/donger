import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteAgentStore } from "../../src/adapters/sqlite-agent-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteFeedbackStore } from "../../src/adapters/sqlite-feedback-store.js";
import { SqliteLoopStore } from "../../src/adapters/sqlite-loop-store.js";
import { SqliteTriggerQueueStore } from "../../src/adapters/sqlite-trigger-queue-store.js";
import { SqliteTriggerStore } from "../../src/adapters/sqlite-trigger-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import type { EventTriggerDispatcher } from "../../src/orchestrator/event-trigger-dispatcher.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

/**
 * 事件触发器 HTTP 契约（spec 2026-09-28-event-trigger-feedback-design §6/§8）：
 * event 类型触发器 admin-only（跨用户反馈泄漏收口）、反馈创建发射 feedback.created、
 * loop 详情附 queuedCount、删除 loop 级联清队列。
 */

let web: WebChannel;
let db: Database.Database;
let tmpDir: string;
let userStore: SqliteUserStore;
let sessionStore: JwtSessionStore;
let triggerStore: SqliteTriggerStore;
let workflowStore: SqliteWorkflowStore;
let loopStore: SqliteLoopStore;
let agentStore: SqliteAgentStore;
let triggerQueue: SqliteTriggerQueueStore;
const dispatchMock = vi.fn().mockResolvedValue(undefined);
const realFetch = globalThis.fetch;

async function startChannel(): Promise<number> {
  db = new Database(":memory:");
  sessionStore = new JwtSessionStore(db, "evt-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir: tmpDir });
  userStore.migrate();
  userStore.migrateCredentials();
  triggerStore = new SqliteTriggerStore(db);
  triggerStore.migrate();
  workflowStore = new SqliteWorkflowStore(db);
  workflowStore.migrate();
  loopStore = new SqliteLoopStore(db);
  loopStore.migrate();
  triggerQueue = new SqliteTriggerQueueStore(db);
  triggerQueue.migrate();
  const feedbackStore = new SqliteFeedbackStore(db);
  feedbackStore.migrate();
  agentStore = new SqliteAgentStore(db, createSecretCipher("pw"));
  agentStore.migrate();
  const convStore = new SqliteConversationStore(db);
  convStore.migrate();
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    feedbackStore,
    agentStore,
    conversationStore: convStore,
    triggerStore,
    workflowStore,
    loopStore,
    triggerQueue,
    eventTriggers: { dispatch: dispatchMock } as unknown as EventTriggerDispatcher,
  });
  web.onMessage(() => {});
  await web.ready();
  if (!web.boundPort) throw new Error("server not listening");
  return web.boundPort;
}

async function makeUser(name: string, role?: "admin"): Promise<{ id: string; token: string }> {
  const user = await userStore.getOrCreateByIdentity("test", name, name);
  if (role === "admin") await userStore.updateRole(user.id, "admin");
  const { token } = await sessionStore.create(user.id);
  return { id: user.id, token };
}

function req(
  port: number,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<Response> {
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "evt-api-"));
  dispatchMock.mockClear();
  await startChannel();
});
afterEach(async () => {
  await web.stop();
});

function boundPort(): number {
  const p = web.boundPort;
  if (!p) throw new Error("server not listening");
  return p;
}

describe("event 触发器 admin-only（POST/PUT /api/triggers）", () => {
  it("member 创建 event 触发器 403；admin 201", async () => {
    const port = boundPort();
    const member = await makeUser("member1");
    const admin = await makeUser("admin1", "admin");
    const memberRes = await req(port, "POST", "/api/triggers", member.token, {
      name: "反馈触发",
      type: "event",
      event: { name: "feedback.created", matcher: { kind: "always" } },
    });
    expect(memberRes.status).toBe(403);
    const adminRes = await req(port, "POST", "/api/triggers", admin.token, {
      name: "反馈触发",
      type: "event",
      event: { name: "feedback.created", matcher: { kind: "always" } },
    });
    expect(adminRes.status).toBe(201);
    const created = (await adminRes.json()) as { id: string };
    // member 也不许把自己的触发器改成 event
    const memberRes2 = await req(port, "POST", "/api/triggers", member.token, {
      name: "定时触发",
      type: "scheduler",
      scheduler: {
        cron: "* * * * *",
        source: { type: "file", path: "x.txt" },
        matcher: { kind: "always" },
      },
    });
    expect(memberRes2.status).toBe(201);
    const memberTrigger = (await memberRes2.json()) as { id: string };
    const putRes = await req(port, "PUT", `/api/triggers/${memberTrigger.id}`, member.token, {
      name: "反馈触发",
      type: "event",
      event: { name: "feedback.created", matcher: { kind: "always" } },
    });
    expect(putRes.status).toBe(403);
    // admin 编辑自己已有的 event 触发器放行
    const putAdmin = await req(port, "PUT", `/api/triggers/${created.id}`, admin.token, {
      name: "反馈触发2",
      type: "event",
      event: { name: "feedback.created", matcher: { kind: "bodyContains", keyword: "导出" } },
    });
    expect(putAdmin.status).toBe(200);
  });
});

describe("反馈创建 → feedback.created 事件发射", () => {
  it("POST /api/feedback 后 dispatch 携带完整 payload（含提交人姓名）", async () => {
    const port = boundPort();
    const user = await makeUser("张三");
    const res = await req(port, "POST", "/api/feedback", user.token, {
      category: "feature",
      content: "希望支持批量导出",
      images: [],
    });
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    const [eventName, payload] = dispatchMock.mock.calls[0] as [string, string];
    expect(eventName).toBe("feedback.created");
    const parsed = JSON.parse(payload) as {
      event: string;
      feedback: { content: string; submitterName: string; categoryLabel: string; status: string };
    };
    expect(parsed.feedback.content).toBe("希望支持批量导出");
    expect(parsed.feedback.submitterName).toBe("张三");
    expect(parsed.feedback.categoryLabel).toBe("功能");
    expect(parsed.feedback.status).toBe("open");
  });

  it("dispatch 抛错不影响反馈提交（fail-open 仍 201）", async () => {
    const port = boundPort();
    dispatchMock.mockRejectedValueOnce(new Error("boom"));
    const user = await makeUser("李四");
    const res = await req(port, "POST", "/api/feedback", user.token, {
      category: "ui",
      content: "按钮太小",
    });
    expect(res.status).toBe(201);
  });
});

describe("loop 队列联动", () => {
  async function makeLoop(token: string, ownerId: string): Promise<string> {
    const port = boundPort();
    const agent = await agentStore.create({
      ownerId,
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      credentials: [],
      gitRepositories: [],
      extensionDirectories: [],
      gitAllowShellGit: false,
      defaultPermissionMode: "ask_before_change",
    });
    const tRes = await req(port, "POST", "/api/triggers", token, {
      name: "T",
      type: "hook",
      hook: {
        path: `/hooks/${Math.random().toString(16).slice(2, 10)}`,
        matcher: { kind: "always" },
      },
    });
    const t = (await tRes.json()) as { id: string };
    const wRes = await req(port, "POST", "/api/workflows", token, {
      name: "W",
      triggerId: t.id,
      agentId: agent.id,
      promptTemplate: "do",
    });
    const w = (await wRes.json()) as { id: string };
    const lRes = await req(port, "POST", "/api/loops", token, { name: "L", workflowId: w.id });
    return ((await lRes.json()) as { id: string }).id;
  }

  it("loop 详情附 queuedCount；删除 loop 级联清队列", async () => {
    const port = boundPort();
    const user = await makeUser("王五");
    const loopId = await makeLoop(user.token, user.id);
    await triggerQueue.enqueue(
      { loopId, triggerId: "t", eventName: "feedback.created", payload: "p" },
      10,
    );
    const detailRes = await req(port, "GET", `/api/loops/${loopId}`, user.token);
    expect(((await detailRes.json()) as { queuedCount: number }).queuedCount).toBe(1);
    // 手动入队第二发在删除前验证级联
    await triggerQueue.enqueue(
      { loopId, triggerId: "t", eventName: "feedback.created", payload: "p2" },
      10,
    );
    const delRes = await req(port, "DELETE", `/api/loops/${loopId}`, user.token);
    expect(delRes.status).toBe(200);
    expect(await triggerQueue.countPending(loopId)).toBe(0);
  });
});
