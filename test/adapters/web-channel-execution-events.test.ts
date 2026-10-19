import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteAgentStore } from "../../src/adapters/sqlite-agent-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteEventFiringStore } from "../../src/adapters/sqlite-event-firing-store.js";
import { SqliteEventStore } from "../../src/adapters/sqlite-event-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { SqliteWorkflowRunStore } from "../../src/adapters/sqlite-workflow-run-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

/**
 * 执行完成事件 HTTP 契约（spec 2026-10-19-execution-completion-events-design）：
 * D9 权限分流（feedback.created admin-only，完成事件全员可建）、D4 主体校验
 * （智能体须可使用/工作流须本人所有）、D5 自订阅静态拒绝。
 */

let web: WebChannel;
let db: Database.Database;
let tmpDir: string;
let userStore: SqliteUserStore;
let sessionStore: JwtSessionStore;
let eventStore: SqliteEventStore;
let workflowStore: SqliteWorkflowStore;
let agentStore: SqliteAgentStore;
const dispatchMock = vi.fn().mockResolvedValue(undefined);
const realFetch = globalThis.fetch;

async function startChannel(): Promise<number> {
  db = new Database(":memory:");
  sessionStore = new JwtSessionStore(db, "exec-evt-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir: tmpDir });
  userStore.migrate();
  userStore.migrateCredentials();
  eventStore = new SqliteEventStore(db);
  eventStore.migrate();
  workflowStore = new SqliteWorkflowStore(db);
  workflowStore.migrate();
  const runStore = new SqliteWorkflowRunStore(db);
  runStore.migrate();
  const firingStore = new SqliteEventFiringStore(db);
  firingStore.migrate();
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
    agentStore,
    conversationStore: convStore,
    eventStore,
    workflowStore,
    workflowRunStore: runStore,
    eventFiringStore: firingStore,
    systemEvents: { dispatch: dispatchMock },
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

async function makeAgent(ownerId: string, name: string) {
  return agentStore.create({
    ownerId,
    name,
    skills: [],
    tools: { mode: "all", whitelist: [] },
    mcpServers: [],
  } as never);
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
  tmpDir = mkdtempSync(join(tmpdir(), "exec-evt-api-"));
  dispatchMock.mockClear();
  await startChannel();
});
afterEach(async () => {
  await web.stop();
});

describe("执行完成事件 HTTP 契约", () => {
  it("D9：member 可建智能体/工作流完成事件；feedback.created 仍 admin-only", async () => {
    const port = web.boundPort as number;
    const member = await makeUser("m1");
    const agent = await makeAgent(member.id, "A01");

    const ok = await req(port, "POST", "/api/events", member.token, {
      name: "A01完成",
      type: "system",
      system: { name: "agent.execution.completed", subjects: [agent.id], timing: "all" },
    });
    expect(ok.status).toBe(201);
    const created = (await ok.json()) as { system?: { subjects?: string[]; timing?: string } };
    expect(created.system?.subjects).toEqual([agent.id]);
    expect(created.system?.timing).toBe("all");

    const denied = await req(port, "POST", "/api/events", member.token, {
      name: "新反馈",
      type: "system",
      system: { name: "feedback.created", matcher: { kind: "always" } },
    });
    expect(denied.status).toBe(403);

    const admin = await makeUser("root1", "admin");
    const adminOk = await req(port, "POST", "/api/events", admin.token, {
      name: "新反馈",
      type: "system",
      system: { name: "feedback.created", matcher: { kind: "always" } },
    });
    expect(adminOk.status).toBe(201);
  });

  it("D4：完成事件主体校验——不可用智能体/他人工作流 400；schema 拒绝无主体", async () => {
    const port = web.boundPort as number;
    const member = await makeUser("m2");
    const stranger = await makeUser("m2-stranger");
    const strangerAgent = await makeAgent(stranger.id, "别人的");
    const strangerWf = await workflowStore.create({
      ownerId: stranger.id,
      name: "别人的工作流",
      eventId: (
        await eventStore.create({
          ownerId: stranger.id,
          name: "定时",
          type: "schedule",
          schedule: { cron: "0 9 * * *", mode: "unconditional" },
        })
      ).id,
      agentId: (await makeAgent(stranger.id, "别人的A")).id,
    });

    const badAgent = await req(port, "POST", "/api/events", member.token, {
      name: "x",
      type: "system",
      system: { name: "agent.execution.completed", subjects: [strangerAgent.id] },
    });
    expect(badAgent.status).toBe(400);

    const badWf = await req(port, "POST", "/api/events", member.token, {
      name: "x",
      type: "system",
      system: { name: "workflow.execution.completed", subjects: [strangerWf.id] },
    });
    expect(badWf.status).toBe(400);

    const noSubject = await req(port, "POST", "/api/events", member.token, {
      name: "x",
      type: "system",
      system: { name: "agent.execution.completed", subjects: [] },
    });
    expect(noSubject.status).toBe(400);
  });

  it("D5：工作流订阅自身智能体/自身的完成事件 → 400 SELF_SUBSCRIPTION_INVALID", async () => {
    const port = web.boundPort as number;
    const member = await makeUser("m3");
    const agent = await makeAgent(member.id, "A01");
    const scheduleEvent = await eventStore.create({
      ownerId: member.id,
      name: "定时",
      type: "schedule",
      schedule: { cron: "0 9 * * *", mode: "unconditional" },
    });
    const selfAgentEvent = await eventStore.create({
      ownerId: member.id,
      name: "A01完成",
      type: "system",
      system: { name: "agent.execution.completed", subjects: [agent.id] },
    });
    // POST 即拦：新建工作流绑定 A01 又订阅 A01 完成事件 = 自环
    const post = await req(port, "POST", "/api/workflows", member.token, {
      name: "自环",
      eventId: selfAgentEvent.id,
      agentId: agent.id,
    });
    expect(post.status).toBe(400);
    const postBody = (await post.json()) as { error?: string };
    expect(postBody.error).toContain("触发自身");

    // 正常建好后 PUT 换绑自身完成事件同样拦（workflow.execution.completed 视角）
    const wf = await workflowStore.create({
      ownerId: member.id,
      name: "正常",
      eventId: scheduleEvent.id,
      agentId: agent.id,
    });
    const selfWfEvent = await eventStore.create({
      ownerId: member.id,
      name: "自身完成",
      type: "system",
      system: { name: "workflow.execution.completed", subjects: [wf.id] },
    });
    const put = await req(port, "PUT", `/api/workflows/${wf.id}`, member.token, {
      name: "正常",
      eventId: selfWfEvent.id,
      agentId: agent.id,
    });
    expect(put.status).toBe(400);
    const putBody = (await put.json()) as { error?: string };
    expect(putBody.error).toContain("触发自身");
  });
});
