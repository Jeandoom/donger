import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { InMemoryUsageStore } from "../../src/adapters/in-memory-usage-store.js";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteMessageStore } from "../../src/adapters/sqlite-message-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import type { Task } from "../../src/domain/types.js";

/**
 * IDOR 契约测试（设计规格 §3.3）：用户 A 携本人 token 访问用户 B 的资源必须 403/404，
 * admin 直通，未登记路由 fail-closed 404。每个用例对应审计报告的一颗 P0 雷。
 */

let db: Database.Database;
let usersDir: string;
let tmpDir: string;
let web: WebChannel;
let userStore: SqliteUserStore;
let taskStore: InMemoryTaskStore;
let usageStore: InMemoryUsageStore;
let sessionStore: JwtSessionStore;
let convStore: SqliteConversationStore;
let auditStore: InMemoryAuditStore;
const realFetch = globalThis.fetch;

const ALICE = "u-alice";
const BOB = "u-bob";

async function startChannel(): Promise<number> {
  db = new Database(":memory:");
  sessionStore = new JwtSessionStore(db, "idor-test-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
  userStore.migrate();
  userStore.migrateCredentials();
  const conversations = new SqliteConversationStore(db);
  conversations.migrate();
  convStore = conversations;
  const messages = new SqliteMessageStore(db);
  messages.migrate();
  taskStore = new InMemoryTaskStore();
  usageStore = new InMemoryUsageStore();
  auditStore = new InMemoryAuditStore({
    conversationOwner: async (id) => (await conversations.get(id))?.userId,
  });

  // 两个普通用户 + admin 用户 + 各自资源
  await userStore.getOrCreateByIdentity("test", ALICE, "Alice");
  await userStore.getOrCreateByIdentity("test", BOB, "Bob");
  const adminSeed = await userStore.getOrCreateByIdentity("test", "admin", "Root");
  await userStore.updateRole(adminSeed.id, "admin");
  const bobConv = await conversations.create(BOB, "web", "bob 的会话");
  await messages.add(bobConv.id, "user", "bob 的私密消息");
  await auditStore.record({
    conversationId: bobConv.id,
    taskId: "task-bob",
    userId: BOB,
    seq: 0,
    type: "user_message",
    text: "bob 的私密消息",
    recordedAt: new Date().toISOString(),
  });
  await taskStore.create(makeTask("task-bob", BOB));
  await usageStore.record({
    conversationId: bobConv.id,
    taskId: "task-bob",
    userId: BOB,
    model: "glm-test",
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });

  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    conversationStore: conversations,
    messageStore: messages,
    taskStore,
    usageStore,
    auditStore,
  });
  web.onMessage(() => {});
  await web.ready();
  if (!web.boundPort) throw new Error("server not listening");
  return web.boundPort;
}

/** findByIdentity 的判空包装（消除非空断言） */
async function userIdOf(externalId: string): Promise<string> {
  const u = await userStore.findByIdentity("test", externalId);
  if (!u) throw new Error(`missing user: ${externalId}`);
  return u.id;
}

function makeTask(id: string, requesterId: string): Task {
  const now = new Date().toISOString();
  return {
    id,
    channelId: "web",
    threadId: "conv-x",
    requesterId,
    prompt: "secret prompt",
    status: "done",
    skillChain: [],
    createdAt: now,
    updatedAt: now,
  };
}

async function tokenFor(externalId: string): Promise<string> {
  const user = await userStore.findByIdentity("test", externalId);
  if (!user) throw new Error(`user missing: ${externalId}`);
  const { token } = await sessionStore.create(user.id);
  return token;
}

function request(
  port: number,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  usersDir = mkdtempSync(join(tmpdir(), "idor-users-"));
  tmpDir = mkdtempSync(join(tmpdir(), "idor-ws-"));
});
afterEach(() => {
  void web?.stop();
  db?.close();
  rmSync(usersDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("IDOR 契约：alice（普通用户）访问 bob 的资源", () => {
  let port: number;
  let alice: string;
  let bobConvId: string;

  beforeEach(async () => {
    port = await startChannel();
    alice = await tokenFor(ALICE);
    const convs = await (async () => {
      const r = await request(port, "GET", "/api/conversations", alice);
      return (await r.json()) as Array<{ id: string }>;
    })();
    expect(convs).toHaveLength(0);
    // bob 的会话 id 从 store 侧取（alice 不可见是另一条断言）
    const all = db.prepare("SELECT id FROM conversations WHERE userId = ?").all(BOB) as Array<{
      id: string;
    }>;
    const first = all[0];
    if (!first) throw new Error("bob conversation missing");
    bobConvId = first.id;
  });

  it("会话消息：403（P0-1）", async () => {
    const r = await request(port, "GET", `/api/conversations/${bobConvId}/messages`, alice);
    expect(r.status).toBe(403);
  });

  it("会话 SSE 流：403（P0-6）", async () => {
    const r = await request(port, "GET", `/api/conversations/${bobConvId}/stream`, alice);
    expect(r.status).toBe(403);
    r.body?.cancel();
  });

  it("会话删除：403（P0-7）", async () => {
    const r = await request(port, "DELETE", `/api/conversations/${bobConvId}`, alice);
    expect(r.status).toBe(403);
  });

  it("会话权限模式修改：403", async () => {
    const r = await request(port, "PATCH", `/api/conversations/${bobConvId}`, alice, {
      permissionMode: "full_access",
    });
    expect(r.status).toBe(403);
  });

  it("会话执行事件：403", async () => {
    const r = await request(port, "GET", `/api/conversations/${bobConvId}/events`, alice);
    expect(r.status).toBe(403);
  });

  it("会话列表只含本人：GET /api/conversations 无 bob 会话（P0-5）", async () => {
    const r = await request(port, "GET", "/api/conversations", alice);
    const list = (await r.json()) as Array<{ id: string }>;
    expect(list.map((c) => c.id)).not.toContain(bobConvId);
  });

  it("会话列表 userId 代查被忽略：?userId=bob 仍返回 alice 自己的（P0-5）", async () => {
    const bobId = await userIdOf(BOB);
    const r = await request(port, "GET", `/api/conversations?userId=${bobId}`, alice);
    const list = (await r.json()) as Array<{ id: string }>;
    expect(list.map((c) => c.id)).not.toContain(bobConvId);
  });

  it("创建会话归属强制为本人：body.userId=bob 被忽略（P0-5）", async () => {
    const bobId = await userIdOf(BOB);
    const r = await request(port, "POST", "/api/conversations", alice, { userId: bobId });
    expect(r.status).toBe(201);
    const conv = (await r.json()) as { userId: string };
    expect(conv.userId).not.toBe(bobId);
  });

  it("任务详情/事件/评论：403（P0-3）", async () => {
    for (const path of [
      "/api/tasks/task-bob",
      "/api/tasks/task-bob/events",
      "/api/tasks/task-bob/comments",
    ]) {
      const r = await request(port, "GET", path, alice);
      expect(r.status).toBe(403);
    }
    const post = await request(port, "POST", "/api/tasks/task-bob/comments", alice, {
      text: "跨用户注入评论",
    });
    expect(post.status).toBe(403);
  });

  it("任务列表按 requester 过滤：alice 看不到 bob 的任务（P0-3）", async () => {
    const r = await request(port, "GET", "/api/tasks", alice);
    const tasks = (await r.json()) as Array<{ id: string }>;
    expect(tasks.map((t) => t.id)).not.toContain("task-bob");
  });

  it("审计列表仅本人会话；他人会话详情 403（P0-2，收口为按属主可见）", async () => {
    const list = await request(port, "GET", "/api/audit/conversations", alice);
    expect(list.status).toBe(200);
    const items = (await list.json()) as Array<{ conversationId: string }>;
    expect(items.map((i) => i.conversationId)).not.toContain(bobConvId);
    const detail = await request(port, "GET", `/api/audit/conversations/${bobConvId}`, alice);
    expect(detail.status).toBe(403);
  });

  it("用户列表：member 403（P0-4）", async () => {
    const r = await request(port, "GET", "/api/users", alice);
    expect(r.status).toBe(403);
  });

  it("他人记忆：403；本人记忆 200（P0-4）", async () => {
    const bobId = await userIdOf(BOB);
    const aliceId = await userIdOf(ALICE);
    const denied = await request(port, "GET", `/api/users/${bobId}/memory`, alice);
    expect(denied.status).toBe(403);
    const own = await request(port, "GET", `/api/users/${aliceId}/memory`, alice);
    expect(own.status).toBe(200);
  });

  it("用量记录按本人过滤：alice 查询无 bob 记录（P0-3）", async () => {
    const r = await request(port, "GET", "/api/usage", alice);
    const body = (await r.json()) as { records: Array<{ userId: string }> };
    expect(body.records.map((x) => x.userId)).not.toContain(BOB);
  });

  it("不存在的会话（他人伪造 id）：404 且不区分语义", async () => {
    const r = await request(port, "GET", "/api/conversations/no-such-conv/messages", alice);
    expect(r.status).toBe(404);
  });
});

describe("IDOR 契约：admin 直通与 fail-closed", () => {
  it("admin 可读他人会话消息与审计（管理面语义）", async () => {
    const port = await startChannel();
    const admin = await tokenFor("admin");
    const all = db.prepare("SELECT id FROM conversations WHERE userId = ?").all(BOB) as Array<{
      id: string;
    }>;
    const bobFirst = all[0];
    if (!bobFirst) throw new Error("bob conversation missing");
    const r = await request(port, "GET", `/api/conversations/${bobFirst.id}/messages`, admin);
    expect(r.status).toBe(200);
    const audit = await request(port, "GET", "/api/audit/conversations", admin);
    expect(audit.status).toBe(200);
    const items = (await audit.json()) as Array<{ conversationId: string }>;
    expect(items.map((i) => i.conversationId)).toContain(bobFirst.id);
  });

  it("未登记路由 fail-closed：已登录也 404", async () => {
    const port = await startChannel();
    const alice = await tokenFor(ALICE);
    const r = await request(port, "GET", "/api/definitely-not-a-route", alice);
    expect(r.status).toBe(404);
  });

  it("未登录访问受保护路由：401", async () => {
    const port = await startChannel();
    const r = await request(port, "GET", "/api/tasks", "not-a-token");
    expect(r.status).toBe(401);
  });
});

describe("IDOR 契约：member 可读本人审计（历史会话/LLM 观测面向本人开放）", () => {
  /** 给 alice 建一个带审计事件的本人会话（属主用内部用户 id，与 viewer.id 对齐） */
  async function seedAliceAudit(): Promise<string> {
    const aliceId = await userIdOf(ALICE);
    const conv = await convStore.create(aliceId, "web", "alice 的会话");
    await auditStore.record({
      conversationId: conv.id,
      taskId: "task-alice",
      userId: aliceId,
      seq: 0,
      type: "user_message",
      text: "alice 的消息",
      recordedAt: new Date().toISOString(),
    });
    return conv.id;
  }

  it("审计列表：member 200 且含本人会话", async () => {
    const port = await startChannel();
    const alice = await tokenFor(ALICE);
    const convId = await seedAliceAudit();
    const r = await request(port, "GET", "/api/audit/conversations", alice);
    expect(r.status).toBe(200);
    const items = (await r.json()) as Array<{ conversationId: string }>;
    expect(items.map((i) => i.conversationId)).toContain(convId);
  });

  it("审计详情：member 读本人会话 200 且按轮返回", async () => {
    const port = await startChannel();
    const alice = await tokenFor(ALICE);
    const convId = await seedAliceAudit();
    const r = await request(port, "GET", `/api/audit/conversations/${convId}`, alice);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { turns: unknown[] };
    expect(body.turns).toHaveLength(1);
  });
});
