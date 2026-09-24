import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteMcpTokenStore } from "../../src/adapters/sqlite-mcp-token-store.js";
import { SqliteMessageStore } from "../../src/adapters/sqlite-message-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import type { IncomingMessage } from "../../src/domain/types.js";

/**
 * MCP 端点 e2e（spec 2026-09-24-mcp-auth-files-design）：
 * 令牌签发/吊销 API + /mcp JSON-RPC（Bearer 鉴权、工具权限与 web 同口径）。
 */

describe("MCP 端点（/mcp + /api/mcp/tokens）", () => {
  let db: Database.Database;
  let web: WebChannel;
  let port = 0;
  let ownerJwt: string;
  let ownerConvId: string;
  let otherMcpToken = "";
  let submitted: IncomingMessage[];

  beforeEach(async () => {
    db = new Database(":memory:");
    const sessionStore = new JwtSessionStore(db, "test-secret");
    sessionStore.migrate();
    const userStore = new SqliteUserStore(db, {
      adminExternalIds: new Set(),
      usersDir: mkdtempSync(join(tmpdir(), "mcp-users-")),
    });
    userStore.migrate();
    const owner = await userStore.getOrCreateByIdentity("internal", "mcp-owner", "属主");
    const other = await userStore.getOrCreateByIdentity("internal", "mcp-other", "旁人");
    ownerJwt = (await sessionStore.create(owner.id)).token;
    const otherJwt = (await sessionStore.create(other.id)).token;

    const convStore = new SqliteConversationStore(db);
    convStore.migrate();
    const conv = await convStore.create(owner.id, "web", "属主会话");
    ownerConvId = conv.id;
    const otherConv = await convStore.create(other.id, "web", "旁人会话");

    const messageStore = new SqliteMessageStore(db);
    messageStore.migrate();
    const mcpTokenStore = new SqliteMcpTokenStore(db);
    mcpTokenStore.migrate();

    const tmp = mkdtempSync(join(tmpdir(), "mcp-ws-"));
    web = new WebChannel({
      port: 0,
      workspaceDir: tmp,
      sessionStore,
      userStore,
      conversationStore: convStore,
      messageStore,
      mcpTokenStore,
    });
    submitted = [];
    web.onMessage((m) => submitted.push(m));
    await web.ready();
    port = web.boundPort ?? 0;
    if (!port) throw new Error("no port");

    // 旁人令牌供跨用户隔离断言
    const res = await fetch(`http://127.0.0.1:${port}/api/mcp/tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${otherJwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "other", expiresInDays: null }),
    });
    expect(res.status).toBe(201);
    otherMcpToken = ((await res.json()) as { token: string }).token;
  });

  afterEach(() => {
    web?.stop?.();
    db?.close();
  });

  async function issueToken(name: string, expiresInDays: number | null = null) {
    const res = await fetch(`http://127.0.0.1:${port}/api/mcp/tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerJwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, expiresInDays }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { token: string; record: { id: string }; endpoint: string };
  }

  async function mcpCall(mcpToken: string, body: unknown) {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${mcpToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res;
  }

  it("令牌 API：签发（明文只出现一次）→ 列表（提示符）→ 吊销 → 重复吊销 404", async () => {
    const issued = await issueToken("zcode 接入", 30);
    expect(issued.token.startsWith("dgk_")).toBe(true);
    expect(issued.endpoint.endsWith("/mcp")).toBe(true);

    const listRes = await fetch(`http://127.0.0.1:${port}/api/mcp/tokens`, {
      headers: { Authorization: `Bearer ${ownerJwt}` },
    });
    const list = (await listRes.json()) as {
      tokens: Array<{ id: string; tokenHint: string; expiresAt: string | null }>;
    };
    expect(list.tokens).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(issued.token);
    expect(list.tokens[0]?.expiresAt).toBeTruthy();

    const del = await fetch(`http://127.0.0.1:${port}/api/mcp/tokens/${issued.record.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerJwt}` },
    });
    expect(del.status).toBe(200);
    const delAgain = await fetch(`http://127.0.0.1:${port}/api/mcp/tokens/${issued.record.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerJwt}` },
    });
    expect(delAgain.status).toBe(404);
  });

  it("令牌 API：非法有效期 400；无 JWT 401", async () => {
    const bad = await fetch(`http://127.0.0.1:${port}/api/mcp/tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerJwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", expiresInDays: 0 }),
    });
    expect(bad.status).toBe(400);
    const noAuth = await fetch(`http://127.0.0.1:${port}/api/mcp/tokens`, { method: "POST" });
    expect(noAuth.status).toBe(401);
  });

  it("/mcp：无令牌/坏令牌 401；GET 405", async () => {
    expect((await mcpCall("", { jsonrpc: "2.0", id: 1, method: "initialize" })).status).toBe(401);
    expect((await mcpCall("dgk_forged", { jsonrpc: "2.0", id: 1, method: "initialize" })).status).toBe(
      401,
    );
    const get = await fetch(`http://127.0.0.1:${port}/mcp`, {
      headers: { Authorization: "Bearer x" },
    });
    expect(get.status).toBe(405);
  });

  it("/mcp：initialize → tools/list → tools/call 全链路；通知 202", async () => {
    const { token } = await issueToken("e2e");

    const init = await mcpCall(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(initBody.result.protocolVersion).toBe("2025-03-26");
    expect(initBody.result.serverInfo.name).toBe("donger");

    const notified = await mcpCall(token, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notified.status).toBe(202);

    const listed = await mcpCall(token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (await listed.json()) as { result: { tools: Array<{ name: string }> } };
    expect(tools.result.tools.map((t) => t.name)).toContain("send_message");
    expect(tools.result.tools.map((t) => t.name)).toContain("list_conversations");

    const convs = await mcpCall(token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_conversations", arguments: {} },
    });
    const convBody = (await convs.json()) as { result: { content: Array<{ text: string }> } };
    expect(convBody.result.content[0]?.text).toContain("属主会话");
  });

  it("/mcp：send_message 持久化用户消息并投递 handler；跨用户读被拒", async () => {
    const { token } = await issueToken("send");
    const send = await mcpCall(token, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: { conversationId: ownerConvId, text: "来自 MCP 的问候", waitSeconds: 0 },
      },
    });
    const sendBody = (await send.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.stringify(sendBody)).toContain("accepted");

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.channelId).toBe("web");
    expect(submitted[0]?.conversationId).toBe(ownerConvId);
    expect(submitted[0]?.text).toBe("来自 MCP 的问候");

    const msgs = await fetch(`http://127.0.0.1:${port}/api/conversations/${ownerConvId}/messages`, {
      headers: { Authorization: `Bearer ${ownerJwt}` },
    });
    const list = (await msgs.json()) as Array<{ role: string; text: string }>;
    expect(list.some((m) => m.role === "user" && m.text === "来自 MCP 的问候")).toBe(true);

    // 旁人 MCP 令牌读属主会话 → isError（权限与 web 口径一致）
    const cross = await mcpCall(otherMcpToken, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "get_conversation_messages", arguments: { conversationId: ownerConvId } },
    });
    expect(cross.status).toBe(200); // JSON-RPC 传输层成功，工具层报错
    const crossBody = (await cross.json()) as { result: { isError?: boolean } };
    expect(crossBody.result.isError).toBe(true);
  });

  it("过期令牌 → 401", async () => {
    const { token } = await issueToken("short", 1);
    expect((await mcpCall(token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
    db.prepare("UPDATE mcp_tokens SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    const res = await mcpCall(token, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(res.status).toBe(401);
  });
});
