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
import { SqliteFeedbackStore } from "../../src/adapters/sqlite-feedback-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { SqliteWorkflowRunStore } from "../../src/adapters/sqlite-workflow-run-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

/**
 * 自动化模块 HTTP 契约（spec 2026-10-09-events-workflows-refactor-design §8）：
 * system 事件 admin-only（跨用户反馈泄漏收口）、反馈创建发射 feedback.created、
 * 触发记录/执行记录属主隔离、call 事件 path 服务端生成。
 */

let web: WebChannel;
let db: Database.Database;
let tmpDir: string;
let userStore: SqliteUserStore;
let sessionStore: JwtSessionStore;
let eventStore: SqliteEventStore;
let workflowStore: SqliteWorkflowStore;
let runStore: SqliteWorkflowRunStore;
let firingStore: SqliteEventFiringStore;
let agentStore: SqliteAgentStore;
const dispatchMock = vi.fn().mockResolvedValue(undefined);
const realFetch = globalThis.fetch;

async function startChannel(): Promise<number> {
  db = new Database(":memory:");
  sessionStore = new JwtSessionStore(db, "evt-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir: tmpDir });
  userStore.migrate();
  userStore.migrateCredentials();
  eventStore = new SqliteEventStore(db);
  eventStore.migrate();
  workflowStore = new SqliteWorkflowStore(db);
  workflowStore.migrate();
  runStore = new SqliteWorkflowRunStore(db);
  runStore.migrate();
  firingStore = new SqliteEventFiringStore(db);
  firingStore.migrate();
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

describe("system 事件 admin-only（POST/PUT /api/events）", () => {
  it("member 创建 system 事件 403；admin 201", async () => {
    const port = boundPort();
    const member = await makeUser("member1");
    const admin = await makeUser("admin1", "admin");
    const memberRes = await req(port, "POST", "/api/events", member.token, {
      name: "反馈事件",
      type: "system",
      system: { name: "feedback.created", matcher: { kind: "always" } },
    });
    expect(memberRes.status).toBe(403);
    const adminRes = await req(port, "POST", "/api/events", admin.token, {
      name: "反馈事件",
      type: "system",
      system: { name: "feedback.created", matcher: { kind: "always" } },
    });
    expect(adminRes.status).toBe(201);
    const created = (await adminRes.json()) as { id: string };
    // member 也不许把自己的事件改成 system
    const memberRes2 = await req(port, "POST", "/api/events", member.token, {
      name: "定时事件",
      type: "schedule",
      schedule: { cron: "* * * * *", mode: "unconditional" },
    });
    expect(memberRes2.status).toBe(201);
    const memberEvent = (await memberRes2.json()) as { id: string };
    const putRes = await req(port, "PUT", `/api/events/${memberEvent.id}`, member.token, {
      name: "反馈事件",
      type: "system",
      system: { name: "feedback.created", matcher: { kind: "always" } },
    });
    expect(putRes.status).toBe(403);
    // admin 编辑自己已有的 system 事件放行
    const putAdmin = await req(port, "PUT", `/api/events/${created.id}`, admin.token, {
      name: "反馈事件2",
      type: "system",
      system: { name: "feedback.created", matcher: { kind: "bodyContains", keyword: "导出" } },
    });
    expect(putAdmin.status).toBe(200);
  });
});

describe("反馈创建 → feedback.created 系统事件发射", () => {
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

describe("触发/执行记录 API（属主隔离 + 永久保留查询面）", () => {
  async function seed(token: string, ownerId: string): Promise<{ eventId: string; wfId: string }> {
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
    const eRes = await req(port, "POST", "/api/events", token, {
      name: "早报",
      type: "schedule",
      schedule: { cron: "0 9 * * *", mode: "unconditional" },
    });
    const event = (await eRes.json()) as { id: string };
    const wRes = await req(port, "POST", "/api/workflows", token, {
      name: "W",
      eventId: event.id,
      agentId: agent.id,
      promptTemplate: "do",
    });
    const wf = (await wRes.json()) as { id: string };
    return { eventId: event.id, wfId: wf.id };
  }

  it("触发记录列表+详情（扇出 runs）；跨用户 404（防存在性泄露）", async () => {
    const port = boundPort();
    const user = await makeUser("王五");
    const { eventId, wfId } = await seed(user.token, user.id);

    // 模拟一次触发：firing 落行 + 扇出一条 run
    const firing = await firingStore.insert({
      id: "f1",
      eventId,
      ownerId: user.id,
      source: "schedule",
      context: '{"event":"timer"}',
      matchedWorkflowCount: 1,
      firedAt: "2026-10-09T01:00:00Z",
    });
    await runStore.insert({
      id: "r1",
      workflowId: wfId,
      eventId,
      firingId: firing.id,
      eventName: "schedule",
      status: "success",
      context: '{"event":"timer"}',
      queuedAt: "2026-10-09T01:00:00Z",
      startedAt: "2026-10-09T01:00:01Z",
      finishedAt: "2026-10-09T01:00:05Z",
    });

    const list = await req(port, "GET", `/api/events/${eventId}/firings`, user.token);
    expect(((await list.json()) as { firings: unknown[] }).firings.length).toBe(1);
    const detail = await req(port, "GET", `/api/events/${eventId}/firings/f1`, user.token);
    const d = (await detail.json()) as { runs: Array<{ id: string }> };
    expect(d.runs.map((r) => r.id)).toEqual(["r1"]);

    // 跨用户访问 → 404
    const other = await makeUser("赵六");
    const strangerList = await req(port, "GET", `/api/events/${eventId}/firings`, other.token);
    expect(strangerList.status).toBe(404);
    const strangerDetail = await req(port, "GET", `/api/events/${eventId}/firings/f1`, other.token);
    expect(strangerDetail.status).toBe(404);
  });

  it("执行记录列表/stats/run 详情；workflow 删除级联清 runs", async () => {
    const port = boundPort();
    const user = await makeUser("钱七");
    const { wfId } = await seed(user.token, user.id);
    await runStore.insert({
      id: "r2",
      workflowId: wfId,
      eventId: "",
      firingId: null,
      eventName: "manual",
      status: "failed",
      context: "x",
      error: "触发事件队列已满（容量 10），本次执行未运行",
      queuedAt: "2026-10-09T02:00:00Z",
      finishedAt: "2026-10-09T02:00:00Z",
    });

    const runs = await req(port, "GET", `/api/workflows/${wfId}/runs`, user.token);
    const runList = (await runs.json()) as { runs: Array<{ id: string; status: string }> };
    expect(runList.runs[0]?.status).toBe("failed");
    // 失败原因可见（D6）
    expect(JSON.stringify(runList.runs)).toContain("队列已满");

    const stats = await req(port, "GET", `/api/workflows/${wfId}/runs/stats`, user.token);
    const s = (await stats.json()) as { total: number; failed: number };
    expect(s.total).toBe(1);
    expect(s.failed).toBe(1);

    const del = await req(port, "DELETE", `/api/workflows/${wfId}`, user.token);
    expect(del.status).toBe(200);
    expect(await runStore.getRun("r2")).toBeUndefined();
  });

  it("call 事件创建时 path 服务端生成；事件被订阅时删除 409", async () => {
    const port = boundPort();
    const user = await makeUser("孙八");
    const res = await req(port, "POST", "/api/events", user.token, {
      name: "回调",
      type: "call",
      call: {
        path: "/hooks/ignored",
        methods: ["GET", "POST"],
        responseStatus: 200,
        responseBody: "ok",
        matcher: { kind: "always" },
      },
    });
    expect(res.status).toBe(201);
    const event = (await res.json()) as { id: string; call: { path: string } };
    expect(event.call.path).toMatch(/^\/hooks\/[0-9a-f]{16}$/);

    await seed(user.token, user.id);
    // 把新建 workflow 的 eventId 指到 call 事件（订阅）→ 删除 409
    const wRes = await req(port, "POST", "/api/workflows", user.token, {
      name: "W2",
      eventId: event.id,
      agentId: (await agentStore.listByOwner(user.id))[0]?.id,
      promptTemplate: "do",
    });
    expect(wRes.status).toBe(201);
    const del = await req(port, "DELETE", `/api/events/${event.id}`, user.token);
    expect(del.status).toBe(409);
  });
});
