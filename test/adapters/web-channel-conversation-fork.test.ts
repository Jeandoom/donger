import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteMessageStore } from "../../src/adapters/sqlite-message-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import type { StoredMessage } from "../../src/domain/types.js";

/**
 * 会话分叉 API 契约（specs/2026-10-23-conversation-fork-design.md §7/§11）：
 * 守卫矩阵（归档 404/忙 409/空 409/切点不属源 409/他人 404）、复制语义（新 id/原
 * createdAt 保序/taskId 置空/血缘落列/sdkSessionId 空）、配置随复制、DTO 血缘字段。
 * 真存储（better-sqlite3 :memory:）+ 真 JWT 会话，鉴权走真实中间件。
 */

let web: WebChannel;
let db: Database.Database;
let tmpDir: string;
let userStore: SqliteUserStore;
let sessionStore: JwtSessionStore;
let messageStore: SqliteMessageStore;
let convStore: SqliteConversationStore;
let busy: (conversationId: string) => boolean;
const realFetch = globalThis.fetch;

async function startChannel(): Promise<number> {
  db = new Database(":memory:");
  tmpDir = mkdtempSync(join(tmpdir(), "fork-conv-"));
  sessionStore = new JwtSessionStore(db, "fork-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir: tmpDir });
  userStore.migrate();
  userStore.migrateCredentials();
  messageStore = new SqliteMessageStore(db);
  messageStore.migrate();
  convStore = new SqliteConversationStore(db);
  convStore.migrate();
  busy = () => false;
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    conversationStore: convStore,
    messageStore,
    conversationBusyGetter: (id) => busy(id),
  });
  web.onMessage(() => {});
  await web.ready();
  if (!web.boundPort) throw new Error("server not listening");
  return web.boundPort;
}

async function makeUser(name: string): Promise<{ id: string; token: string }> {
  const user = await userStore.getOrCreateByIdentity("test", name, name);
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

interface Seed {
  conversationId: string;
  messages: StoredMessage[];
  sdkSessionId: string;
}

/** 取种子消息（下标越界即失败，替代非空断言） */
function seedAt(seed: Seed, index: number): StoredMessage {
  const message = seed.messages[index];
  if (!message) throw new Error(`seed 缺少第 ${index} 条消息`);
  return message;
}

/** 源会话 + 3 条消息（user/bot 交错，bot 带 taskId，时间错开验证保序） */
async function seedSource(userId: string, title = "排查导出问题"): Promise<Seed> {
  const conv = await convStore.createWithAgent(userId, "web", title, "agent-1");
  const sdkSessionId = "sess-src-1";
  await convStore.update(conv.id, {
    sdkSessionId,
    permissionMode: "risk_guard",
    llmSdkType: "anthropic",
    lastModelRef: "zhipu-cn/glm-4.6",
  });
  const m1 = await messageStore.add(conv.id, "user", "第一条", "[]", undefined, {
    createdAt: "2026-10-26T01:00:00.000Z",
  });
  const m2 = await messageStore.add(conv.id, "bot", "回复一", "[]", "task-a", {
    createdAt: "2026-10-26T01:01:00.000Z",
  });
  const m3 = await messageStore.add(conv.id, "user", "第二条", "[]", undefined, {
    createdAt: "2026-10-26T01:02:00.000Z",
  });
  return { conversationId: conv.id, messages: [m1, m2, m3], sdkSessionId };
}

describe("POST /api/conversations/:id/fork", () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });

  afterEach(async () => {
    await web.stop();
    db.close();
  });

  it("会话级绿路：整史复制 + 血缘/配置落列 + 源会话零扰动", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const seed = await seedSource(alice.id);

    const res = await req(
      port,
      "POST",
      `/api/conversations/${seed.conversationId}/fork`,
      alice.token,
      {},
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      conversation: {
        id: string;
        title: string;
        sdkSessionId: string;
        forkedFrom?: { id: string; title: string };
        forkedFromMessageId?: string;
        permissionMode?: string;
        llmSdkType?: string;
        agentId: string;
      };
      copiedMessages: number;
    };
    expect(body.copiedMessages).toBe(3);
    expect(body.conversation.title).toBe("排查导出问题 · 分叉");
    expect(body.conversation.sdkSessionId).toBe("");
    expect(body.conversation.agentId).toBe("agent-1");
    expect(body.conversation.permissionMode).toBe("risk_guard");
    expect(body.conversation.llmSdkType).toBe("anthropic");
    expect(body.conversation.forkedFrom).toEqual({
      id: seed.conversationId,
      title: "排查导出问题",
    });
    expect(body.conversation.forkedFromMessageId).toBe(seedAt(seed, 2).id);

    // 复制语义：新 id / 原 createdAt / taskId 置空 / 时间正序
    const copied = await messageStore.listByConversation(body.conversation.id);
    expect(copied.map((m) => [m.role, m.text, m.createdAt])).toEqual([
      ["user", "第一条", "2026-10-26T01:00:00.000Z"],
      ["bot", "回复一", "2026-10-26T01:01:00.000Z"],
      ["user", "第二条", "2026-10-26T01:02:00.000Z"],
    ]);
    expect(copied.every((m) => !m.taskId)).toBe(true);
    expect(copied.every((m) => !seed.messages.some((s) => s.id === m.id))).toBe(true);

    // 源会话零扰动：消息数/指针/血缘不变
    expect((await messageStore.listByConversation(seed.conversationId)).length).toBe(3);
    const source = await convStore.get(seed.conversationId);
    expect(source?.sdkSessionId).toBe(seed.sdkSessionId);
    expect(source?.forkedFromConversationId).toBeUndefined();
  });

  it("消息级切点（D5 含此条）：复制到该条为止，血缘指向该条", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const seed = await seedSource(alice.id);

    const res = await req(
      port,
      "POST",
      `/api/conversations/${seed.conversationId}/fork`,
      alice.token,
      { messageId: seedAt(seed, 1).id },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      copiedMessages: number;
      conversation: { forkedFromMessageId?: string };
    };
    expect(body.copiedMessages).toBe(2);
    expect(body.conversation.forkedFromMessageId).toBe(seedAt(seed, 1).id);
  });

  it("守卫矩阵：切点不属源 409 / 空会话 409 / 忙 409 / 归档与他人的 404", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const seed = await seedSource(alice.id);

    const badPoint = await req(
      port,
      "POST",
      `/api/conversations/${seed.conversationId}/fork`,
      alice.token,
      { messageId: "not-in-conversation" },
    );
    expect(badPoint.status).toBe(409);

    const empty = await convStore.create(alice.id, "web", "空会话");
    const emptyRes = await req(
      port,
      "POST",
      `/api/conversations/${empty.id}/fork`,
      alice.token,
      {},
    );
    expect(emptyRes.status).toBe(409);

    busy = (id) => id === seed.conversationId;
    const busyRes = await req(
      port,
      "POST",
      `/api/conversations/${seed.conversationId}/fork`,
      alice.token,
      {},
    );
    expect(busyRes.status).toBe(409);
    busy = () => false;

    await convStore.update(seed.conversationId, { archived: true });
    const archived = await req(
      port,
      "POST",
      `/api/conversations/${seed.conversationId}/fork`,
      alice.token,
      {},
    );
    expect(archived.status).toBe(404);

    // 复位归档后验证他人：route-guard owner 规则非属主 403（守卫层先行，handler 的
    // getVisible→404 是纵深防线的 admin/内部路径）
    await convStore.update(seed.conversationId, { archived: false });
    const stranger = await req(
      port,
      "POST",
      `/api/conversations/${seed.conversationId}/fork`,
      bob.token,
      {},
    );
    expect(stranger.status).toBe(403);
  });
});
