import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteMessageStore } from "../../src/adapters/sqlite-message-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";

/**
 * chat UE 优化轮（specs/2026-11-05-chat-ue-optimization-design.md §4.1）REST 面：
 * 列表 enrich（lastMessagePreview/unreadCount）+ ?q/?archived 过滤 + PATCH title/archived + seen。
 */

describe("WebChannel 会话列表 enrich / 重命名 / 归档 / seen", () => {
  let web: WebChannel;
  let db: Database.Database;
  let conversationStore: SqliteConversationStore;
  let messageStore: SqliteMessageStore;
  let auditStore: InMemoryAuditStore;
  let port: number;
  let token: string;
  let userId: string;
  let workspaceDir: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    const sessionStore = new JwtSessionStore(db, "test-secret");
    sessionStore.migrate();
    const userStore = new SqliteUserStore(db, {
      adminExternalIds: new Set(),
      usersDir: mkdtempSync(join(tmpdir(), "web-meta-users-")),
    });
    userStore.migrate();
    conversationStore = new SqliteConversationStore(db);
    conversationStore.migrate();
    messageStore = new SqliteMessageStore(db);
    messageStore.migrate();
    auditStore = new InMemoryAuditStore();
    workspaceDir = mkdtempSync(join(tmpdir(), "web-meta-ws-"));
    web = new WebChannel({
      port: 0,
      host: "127.0.0.1",
      workspaceDir,
      sessionStore,
      userStore,
      conversationStore,
      messageStore,
      auditStore,
    });
    web.onMessage(() => {});
    await web.ready();
    port = web.boundPort ?? 0;
    // 建测试用户并直签 JWT（绕过验证码通道）
    const user = await userStore.getOrCreateByIdentity("internal", "meta-staff", "列表测试用户");
    userId = user.id;
    const { token: t } = await sessionStore.create(user.id);
    token = t;
  });

  afterEach(async () => {
    await web?.stop();
    db?.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  const auth = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  async function createConv(title: string): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({ channelId: "web" }),
    });
    expect(res.ok).toBe(true);
    const conv = (await res.json()) as { id: string };
    await conversationStore.update(conv.id, { title });
    return conv.id;
  }

  it("列表附 lastMessagePreview 与 unreadCount；seen 后未读清零", async () => {
    const convId = await createConv("未读测试");
    await messageStore.add(convId, "user", "问一句");
    await messageStore.add(convId, "bot", "机器人回答第一条");
    await messageStore.add(convId, "bot", "机器人回答第二条");
    const list = (await (
      await fetch(`http://127.0.0.1:${port}/api/conversations`, { headers: auth() })
    ).json()) as Array<{ id: string; lastMessagePreview?: string; unreadCount?: number }>;
    const row = list.find((c) => c.id === convId);
    expect(row?.lastMessagePreview).toBe("机器人回答第二条");
    expect(row?.unreadCount).toBe(2);
    // 打开会话：seen 清未读，且不刷 updatedAt
    const before = (await conversationStore.get(convId))?.updatedAt;
    const seenRes = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/seen`, {
      method: "POST",
      headers: auth(),
    });
    expect(seenRes.status).toBe(204);
    const conv = await conversationStore.get(convId);
    expect(conv?.lastSeenAt).toBeTruthy();
    expect(conv?.updatedAt).toBe(before);
    const list2 = (await (
      await fetch(`http://127.0.0.1:${port}/api/conversations`, { headers: auth() })
    ).json()) as Array<{ id: string; unreadCount?: number }>;
    expect(list2.find((c) => c.id === convId)?.unreadCount).toBe(0);
  });

  it("?q= 标题过滤（大小写不敏感子串）", async () => {
    await createConv("Alpha 报表");
    await createConv("beta 工单");
    const all = (await (
      await fetch(`http://127.0.0.1:${port}/api/conversations`, { headers: auth() })
    ).json()) as Array<{ title: string }>;
    expect(all.length).toBe(2);
    const filtered = (await (
      await fetch(`http://127.0.0.1:${port}/api/conversations?q=alpha`, { headers: auth() })
    ).json()) as Array<{ title: string }>;
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.title).toBe("Alpha 报表");
  });

  it("PATCH title 重命名落审计；非法 title 400；空字段集 400", async () => {
    const convId = await createConv("旧名");
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({ title: "  新名字  " }),
    });
    expect(res.ok).toBe(true);
    expect((await conversationStore.get(convId))?.title).toBe("新名字");
    const events = await auditStore.listByConversation(convId);
    expect(events.some((e) => e.type === "conversation_renamed")).toBe(true);

    const bad = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({ title: "   " }),
    });
    expect(bad.status).toBe(400);
    const empty = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
  });

  it("DELETE 归档 → ?archived=1 可见 → PATCH archived:false 恢复", async () => {
    const convId = await createConv("归档流");
    const del = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(del.status).toBe(204);
    const active = (await (
      await fetch(`http://127.0.0.1:${port}/api/conversations`, { headers: auth() })
    ).json()) as Array<{ id: string }>;
    expect(active.find((c) => c.id === convId)).toBeUndefined();
    const archived = (await (
      await fetch(`http://127.0.0.1:${port}/api/conversations?archived=1`, { headers: auth() })
    ).json()) as Array<{ id: string }>;
    expect(archived.find((c) => c.id === convId)?.id).toBe(convId);
    const restore = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({ archived: false }),
    });
    expect(restore.ok).toBe(true);
    const active2 = (await (
      await fetch(`http://127.0.0.1:${port}/api/conversations`, { headers: auth() })
    ).json()) as Array<{ id: string }>;
    expect(active2.find((c) => c.id === convId)?.id).toBe(convId);
  });

  it("PATCH permissionMode 既有语义保持不变（单独传仍生效）", async () => {
    const convId = await createConv("模式");
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({ permissionMode: "full_access" }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { permissionMode?: string };
    expect(body.permissionMode).toBe("full_access");
    expect((await conversationStore.get(convId))?.permissionMode).toBe("full_access");
  });

  it("他人会话 PATCH/seen 不可达（route guard owner 口径 403）", async () => {
    const other = await conversationStore.create("someone-else", "web", "别人的会话");
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations/${other.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({ title: "越权改名" }),
    });
    expect(res.status).toBe(403);
    const seen = await fetch(`http://127.0.0.1:${port}/api/conversations/${other.id}/seen`, {
      method: "POST",
      headers: auth(),
    });
    expect(seen.status).toBe(403);
    expect((await conversationStore.get(other.id))?.title).toBe("别人的会话");
    expect(userId).toBeTruthy();
  });
});
