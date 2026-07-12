import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { InMemoryUsageStore } from "../../src/adapters/in-memory-usage-store.js";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { LocalFileBrowser } from "../../src/adapters/local-file-browser.js";
import { SqliteAgentShareStore } from "../../src/adapters/sqlite-agent-share-store.js";
import { SqliteAgentStore } from "../../src/adapters/sqlite-agent-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { resolveStaticFile, WebChannel } from "../../src/adapters/web-channel.js";
import type { LlmPreset } from "../../src/config.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

function makeWebRoot(): string {
  return mkdtempSync(join(tmpdir(), "webroot-"));
}

/** 写文件并自动创建父目录（writeFileSync 不会自动建目录） */
function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe("resolveStaticFile", () => {
  let root: string;
  beforeEach(() => {
    root = makeWebRoot();
  });

  it("有 dist 时，/ 返回 dist/index.html", () => {
    write(root, "dist/index.html", "built");
    const r = resolveStaticFile(root, "/");
    expect(r?.kind).toBe("file");
    expect(r?.absPath).toBe(join(root, "dist", "index.html"));
    expect(existsSync(r?.absPath ?? "")).toBe(true);
  });

  it("有 dist 时，/index.html 返回 dist/index.html", () => {
    write(root, "dist/index.html", "built");
    const r = resolveStaticFile(root, "/index.html");
    expect(r?.absPath).toBe(join(root, "dist", "index.html"));
  });

  it("有 dist 时，未知路径走 SPA fallback 到 dist/index.html", () => {
    write(root, "dist/index.html", "built");
    const r = resolveStaticFile(root, "/agents");
    expect(r?.absPath).toBe(join(root, "dist", "index.html"));
  });

  it("有 dist 时，/assets 下真实文件直返", () => {
    write(root, "dist/index.html", "built");
    write(root, "dist/assets/app.js", "// js");
    const r = resolveStaticFile(root, "/assets/app.js");
    expect(r?.absPath).toBe(join(root, "dist", "assets", "app.js"));
  });

  it("有 dist 时，/assets 缺失文件返回 null（404）", () => {
    write(root, "dist/index.html", "built");
    const r = resolveStaticFile(root, "/assets/missing.js");
    expect(r).toBeNull();
  });

  it("无 dist 时，/ 返回 null（未构建）", () => {
    const r = resolveStaticFile(root, "/");
    expect(r).toBeNull();
  });

  it("无 dist 时，未知路径返回 null", () => {
    const r = resolveStaticFile(root, "/agents");
    expect(r).toBeNull();
  });
});

let web: WebChannel;
afterEach(() => web?.stop());

async function startWith(usageStore: InMemoryUsageStore): Promise<number> {
  const tmp = mkdtempSync(join(tmpdir(), "web-ws-"));
  web = new WebChannel({ port: 0, workspaceDir: tmp, usageStore });
  web.onMessage(() => {});
  await web.ready();
  const port = web.boundPort;
  if (!port) throw new Error("server not listening");
  return port;
}

function rec(userId: string, taskId: string) {
  return {
    taskId,
    userId,
    channelId: "web",
    model: "glm-4.6",
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

describe("WebChannel GET /api/usage", () => {
  it("返回 records 列表", async () => {
    const store = new InMemoryUsageStore();
    await store.record(rec("u1", "t1"));
    const port = await startWith(store);
    const res = await fetch(`http://127.0.0.1:${port}/api/usage`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: { userId: string }[] };
    expect(body.records.length).toBe(1);
    expect(body.records[0]?.userId).toBe("u1");
  });

  it("按 userId 过滤", async () => {
    const store = new InMemoryUsageStore();
    await store.record(rec("u1", "t1"));
    await store.record(rec("u2", "t2"));
    const port = await startWith(store);
    const res = await fetch(`http://127.0.0.1:${port}/api/usage?userId=u1`);
    const body = (await res.json()) as { records: { userId: string }[] };
    expect(body.records.length).toBe(1);
    expect(body.records[0]?.userId).toBe("u1");
  });

  it("limit 非法 → 400", async () => {
    const port = await startWith(new InMemoryUsageStore());
    const res = await fetch(`http://127.0.0.1:${port}/api/usage?limit=abc`);
    expect(res.status).toBe(400);
  });
});

describe("WebChannel auth", () => {
  let web: WebChannel;
  let db: Database.Database;

  afterEach(() => {
    web?.stop();
    db?.close();
  });

  async function createAuthChannel(): Promise<number> {
    db = new Database(":memory:");
    const { JwtSessionStore } = await import("../../src/adapters/jwt-session-store.js");
    const sessionStore = new JwtSessionStore(db, "test-secret");
    sessionStore.migrate();

    const { SqliteUserStore } = await import("../../src/adapters/sqlite-user-store.js");
    const userStore = new SqliteUserStore(db, {
      adminExternalIds: new Set(),
      usersDir: mkdtempSync(join(tmpdir(), "web-auth-users-")),
    });
    userStore.migrate();

    const tmp = mkdtempSync(join(tmpdir(), "web-auth-"));
    web = new WebChannel({ port: 0, workspaceDir: tmp, sessionStore, userStore });
    web.onMessage(() => {});
    await web.ready();
    const port = web.boundPort;
    if (!port) throw new Error("no port");
    return port;
  }

  it("GET /api/auth/me 无 token → 401", async () => {
    const port = await createAuthChannel();
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
    expect(res.status).toBe(401);
  });

  it("GET /api/auth/me 有效 token → 返回用户信息", async () => {
    const port = await createAuthChannel();
    const { SqliteUserStore } = await import("../../src/adapters/sqlite-user-store.js");
    const userStore = new SqliteUserStore(db, {
      adminExternalIds: new Set(),
      usersDir: mkdtempSync(join(tmpdir(), "web-auth-users2-")),
    });
    userStore.migrate();
    // 先创建用户
    const user = await userStore.getOrCreateByIdentity("internal", "test-staff", "测试用户");
    const { JwtSessionStore } = await import("../../src/adapters/jwt-session-store.js");
    const sessionStore = new JwtSessionStore(db, "test-secret");
    sessionStore.migrate();
    const { token } = await sessionStore.create(user.id);
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } };
    expect(body.user.id).toBe(user.id);
  });

  it("GET /api/health 免认证", async () => {
    const port = await createAuthChannel();
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
  });

  // SSE 流鉴权：EventSource 无法设置 Authorization 头，必须支持 ?token= 查询参数
  async function createSessionToken(): Promise<string> {
    const { SqliteUserStore } = await import("../../src/adapters/sqlite-user-store.js");
    const userStore = new SqliteUserStore(db, {
      adminExternalIds: new Set(),
      usersDir: mkdtempSync(join(tmpdir(), "web-auth-users-stream-")),
    });
    userStore.migrate();
    const user = await userStore.getOrCreateByIdentity("internal", "stream-staff", "流测试用户");
    const { JwtSessionStore } = await import("../../src/adapters/jwt-session-store.js");
    const sessionStore = new JwtSessionStore(db, "test-secret");
    sessionStore.migrate();
    const { token } = await sessionStore.create(user.id);
    return token;
  }

  it("GET /api/conversations/:id/stream 无 token → 401", async () => {
    const port = await createAuthChannel();
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations/abc-123/stream`);
    expect(res.status).toBe(401);
  });

  it("GET /api/conversations/:id/stream?token=<有效> → 200 text/event-stream", async () => {
    const port = await createAuthChannel();
    const token = await createSessionToken();
    const res = await fetch(
      `http://127.0.0.1:${port}/api/conversations/abc-123/stream?token=${token}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    // 中断流式连接，避免挂住
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
  });
});

function auditEvent(over: Record<string, unknown>) {
  return { userId: "u1", recordedAt: "2026-07-01T00:00:00.000Z", ...over };
}

describe("WebChannel GET /api/audit/conversations", () => {
  it("返回会话列表（补 title，按 lastAt 倒序）", async () => {
    const db = new Database(":memory:");
    const conversationStore = new SqliteConversationStore(db);
    conversationStore.migrate();
    const created = await conversationStore.create("u1", "web", "修登录bug");
    const auditStore = new InMemoryAuditStore();
    await auditStore.record(
      auditEvent({
        conversationId: created.id,
        taskId: "t1",
        seq: 0,
        type: "user_message",
        text: "hi",
      }) as never,
    );
    web = new WebChannel({
      port: 0,
      workspaceDir: mkdtempSync(join(tmpdir(), "web-")),
      conversationStore,
      auditStore,
    });
    web.onMessage(() => {});
    await web.ready();
    const port = web.boundPort;
    if (!port) throw new Error("no port");
    const res = await fetch(`http://127.0.0.1:${port}/api/audit/conversations`);
    const body = (await res.json()) as Array<{
      conversationId: string;
      title: string;
      turnCount: number;
    }>;
    expect(res.status).toBe(200);
    expect(body[0]?.conversationId).toBe(created.id);
    expect(body[0]?.title).toBe("修登录bug");
    expect(body[0]?.turnCount).toBe(1);
    db.close();
  });
});

describe("WebChannel GET /api/audit/conversations/:id", () => {
  it("返回按轮分组的详情", async () => {
    const db = new Database(":memory:");
    const conversationStore = new SqliteConversationStore(db);
    conversationStore.migrate();
    const created = await conversationStore.create("u1", "web", "t");
    const taskStore = new InMemoryTaskStore();
    const auditStore = new InMemoryAuditStore();
    await auditStore.record(
      auditEvent({
        conversationId: created.id,
        taskId: "t1",
        seq: 0,
        type: "user_message",
        text: "hi",
      }) as never,
    );
    web = new WebChannel({
      port: 0,
      workspaceDir: mkdtempSync(join(tmpdir(), "web-")),
      conversationStore,
      taskStore,
      auditStore,
    });
    web.onMessage(() => {});
    await web.ready();
    const port = web.boundPort;
    if (!port) throw new Error("no port");
    const res = await fetch(`http://127.0.0.1:${port}/api/audit/conversations/${created.id}`);
    const body = (await res.json()) as {
      turns: Array<{ taskId: string; events: Array<{ type: string }> }>;
    };
    expect(res.status).toBe(200);
    expect(body.turns[0]?.taskId).toBe("t1");
    expect(body.turns[0]?.events[0]?.type).toBe("user_message");
    db.close();
  });

  it("无数据 → 404", async () => {
    web = new WebChannel({
      port: 0,
      workspaceDir: mkdtempSync(join(tmpdir(), "web-")),
      auditStore: new InMemoryAuditStore(),
    });
    web.onMessage(() => {});
    await web.ready();
    const port = web.boundPort;
    if (!port) throw new Error("no port");
    const res = await fetch(`http://127.0.0.1:${port}/api/audit/conversations/nope`);
    expect(res.status).toBe(404);
  });
});

describe("WebChannel POST /api/upload", () => {
  let webTmp: string;
  let port: number;

  beforeEach(async () => {
    webTmp = mkdtempSync(join(tmpdir(), "web-upload-"));
    web = new WebChannel({ port: 0, workspaceDir: webTmp });
    web.onMessage(() => {});
    await web.ready();
    const p = web.boundPort;
    if (!p) throw new Error("no port");
    port = p;
  });

  afterEach(() => {
    web?.stop();
    rmSync(webTmp, { recursive: true, force: true });
  });

  it("上传图片成功", async () => {
    const body = new FormData();
    const blob = new Blob(["fake-png"], { type: "image/png" });
    body.append("file", blob, "test.png");
    const res = await fetch(`http://127.0.0.1:${port}/api/upload?threadId=web-1`, {
      method: "POST",
      body,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { path: string; name: string; type: string };
    expect(j.name).toBe("test.png");
    expect(j.type).toBe("image");
    expect(j.path).toContain("sessions");
    expect(j.path).toContain("web-1");
  });

  it("上传 .md 文件成功", async () => {
    const body = new FormData();
    body.append("file", new Blob(["# Hello"], { type: "text/markdown" }), "readme.md");
    const res = await fetch(`http://127.0.0.1:${port}/api/upload?threadId=web-1`, {
      method: "POST",
      body,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { path: string; name: string; type: string };
    expect(j.name).toBe("readme.md");
    expect(j.type).toBe("markdown");
  });

  it("不支持的类型返回 400", async () => {
    const body = new FormData();
    body.append("file", new Blob(["<xml/>"], { type: "text/xml" }), "test.xml");
    const res = await fetch(`http://127.0.0.1:${port}/api/upload?threadId=web-1`, {
      method: "POST",
      body,
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toContain("不支持的文件类型");
  });

  it("无 threadId 返回 400", async () => {
    const body = new FormData();
    body.append("file", new Blob(["fake"], { type: "image/png" }), "test.png");
    const res = await fetch(`http://127.0.0.1:${port}/api/upload`, {
      method: "POST",
      body,
    });
    expect(res.status).toBe(400);
  });

  it("非 multipart 返回 400", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/upload?threadId=web-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("/api/files/*", () => {
  let port: number;
  let token: string;
  let tmpWs: string;

  beforeEach(async () => {
    tmpWs = mkdtempSync(join(tmpdir(), "fb-ws-"));
    const db = new Database(":memory:");
    const usersDir = join(tmpWs, "users");
    const userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
    userStore.migrate();
    const convStore = new SqliteConversationStore(db);
    convStore.migrate();
    const sessionStore = new JwtSessionStore(db, "test-secret", 3600_000);
    sessionStore.migrate();
    const fileBrowser = new LocalFileBrowser({
      userStore,
      conversationStore: convStore,
      workspaceDir: tmpWs,
    });
    web = new WebChannel({ port: 0, workspaceDir: tmpWs, sessionStore, fileBrowser });
    web.onMessage(() => {});
    await web.ready();
    port = web.boundPort ?? 0;
    const user = await userStore.getOrCreateByIdentity("internal", "u1", "alice");
    write(join(tmpWs, "users", user.id), ".skills/SKILL.md", "# hi");
    token = (await sessionStore.create(user.id)).token;
  });

  it("未带 token → 401", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/files/tree?scope=user`);
    expect(r.status).toBe(401);
  });

  it("scope 非法 → 400", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/files/tree?scope=admin&token=${token}`);
    expect(r.status).toBe(400);
  });

  it("runtime 缺 conversationId → 400", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/files/tree?scope=runtime&token=${token}`);
    expect(r.status).toBe(400);
  });

  it("tree 正常返回 nodes", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/files/tree?scope=user&token=${token}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { nodes: { name: string }[] };
    expect(body.nodes.map((n) => n.name)).toContain(".skills");
  });

  it("content 返回 markdown", async () => {
    const r = await fetch(
      `http://127.0.0.1:${port}/api/files/content?scope=user&path=.skills/SKILL.md&token=${token}`,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/markdown");
    expect(await r.text()).toBe("# hi");
  });

  it("content 路径越界 → 403", async () => {
    const r = await fetch(
      `http://127.0.0.1:${port}/api/files/content?scope=user&path=../../x&token=${token}`,
    );
    expect(r.status).toBe(403);
  });

  it("content download=1 带 attachment 头", async () => {
    const r = await fetch(
      `http://127.0.0.1:${port}/api/files/content?scope=user&path=.skills/SKILL.md&download=1&token=${token}`,
    );
    expect(r.headers.get("content-disposition")).toContain("attachment");
  });
});

async function startWebWithAgents(opts: { presets?: LlmPreset[]; skillPaths?: string[] } = {}): Promise<{
  port: number;
  token: string;
  userId: string;
  agentStore: SqliteAgentStore;
  agentShareStore: SqliteAgentShareStore;
}> {
  const tmp = mkdtempSync(join(tmpdir(), "web-agent-"));
  const db = new Database(join(tmp, "t.db"));
  const userStore = new SqliteUserStore(db, {
    adminExternalIds: new Set<string>(),
    usersDir: join(tmp, "users"),
  });
  userStore.migrate();
  const convStore = new SqliteConversationStore(db);
  convStore.migrate();
  const cipher = createSecretCipher("pw");
  const agentStore = new SqliteAgentStore(db, cipher);
  agentStore.migrate();
  const agentShareStore = new SqliteAgentShareStore(db);
  agentShareStore.migrate();
  const sessionStore = new JwtSessionStore(db, "test-secret", 3_600_000);
  sessionStore.migrate();
  const user = await userStore.getOrCreateByIdentity("internal", "webu", "tester");
  const { token } = await sessionStore.create(user.id);
  web = new WebChannel({
    port: 0,
    workspaceDir: tmp,
    userStore,
    conversationStore: convStore,
    sessionStore,
    agentStore,
    agentShareStore,
    agentMeta: { presets: opts.presets ?? [], skillPaths: opts.skillPaths ?? [] },
  });
  web.onMessage(() => {});
  await web.ready();
  const port = web.boundPort;
  if (!port) throw new Error("server not listening");
  return { port, token, userId: user.id, agentStore, agentShareStore };
}

describe("WebChannel /api/agents", () => {
  it("未登录 POST → 401", async () => {
    const { port } = await startWebWithAgents();
    const r = await fetch(`http://127.0.0.1:${port}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "x",
        skills: [],
        tools: { mode: "all", whitelist: [] },
        mcpServers: [],
        llm: {},
      }),
    });
    expect(r.status).toBe(401);
  });

  it("POST 创建 + GET 列表；DTO 不含明文密钥", async () => {
    const { port, token } = await startWebWithAgents();
    const create = await fetch(`http://127.0.0.1:${port}/api/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "A",
        skills: ["s:1"],
        tools: { mode: "all", whitelist: [] },
        mcpServers: [{ name: "m", type: "http", url: "https://x", env: { K: "TOPSECRET" } }],
        llm: {},
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string };
    expect(JSON.stringify(created)).not.toContain("TOPSECRET");

    const list = await fetch(`http://127.0.0.1:${port}/api/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const arr = (await list.json()) as Array<{ id: string }>;
    expect(arr.some((a) => a.id === created.id)).toBe(true);
  });

  it("GET /:id 非 owner 且无授权 → 403", async () => {
    const { port, token, agentStore } = await startWebWithAgents();
    const a = await agentStore.create({
      ownerId: "someone-else",
      name: "X",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
    });
    const r = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(403);
  });

  it("PATCH/DELETE 仅 owner 可用（非 owner → 403）", async () => {
    const { port, token, agentStore } = await startWebWithAgents();
    const a = await agentStore.create({
      ownerId: "someone-else",
      name: "X",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
    });
    const patch = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Y" }),
    });
    expect(patch.status).toBe(403);
    const del = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.status).toBe(403);
  });

  it("owner PATCH 改名 + 删除生效", async () => {
    const { port, token, userId, agentStore } = await startWebWithAgents();
    const a = await agentStore.create({
      ownerId: userId,
      name: "X",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
    });
    const patch = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Y" }),
    });
    expect(((await patch.json()) as { name: string }).name).toBe("Y");
    const del = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.status).toBe(204);
    expect(await agentStore.get(a.id)).toBeUndefined();
  });

  it("meta/options 返回 tools + presets", async () => {
    const { port, token } = await startWebWithAgents({
      presets: [{ id: "p", name: "G", model: "m", baseUrl: "u" }],
    });
    const r = await fetch(`http://127.0.0.1:${port}/api/agents/meta/options`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const j = (await r.json()) as { tools: string[]; llmPresets: unknown[] };
    expect(j.tools).toContain("Bash");
    expect(j.llmPresets.length).toBe(1);
  });

  it("GET /:id/conversation get-or-create（幂等）", async () => {
    const { port, token, userId, agentStore } = await startWebWithAgents();
    const a = await agentStore.create({
      ownerId: userId,
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
    });
    const r1 = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}/conversation`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const c1 = (await r1.json()) as { id: string; agentId: string };
    expect(c1.agentId).toBe(a.id);
    const r2 = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}/conversation`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const c2 = (await r2.json()) as { id: string };
    expect(c2.id).toBe(c1.id);
  });
});
