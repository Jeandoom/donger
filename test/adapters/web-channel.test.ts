import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { GitAccessGate } from "../../src/orchestrator/git-access-gate.js";
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
  let receivedFiles: Array<{ path: string; name: string; type: string }> | undefined;

  beforeEach(async () => {
    webTmp = mkdtempSync(join(tmpdir(), "web-upload-"));
    web = new WebChannel({ port: 0, workspaceDir: webTmp });
    web.onMessage((message) => {
      receivedFiles = message.files;
    });
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

  it("发送消息时把当前会话附件传给消息处理器", async () => {
    const upload = new FormData();
    upload.append("file", new Blob(["# Hello"], { type: "text/markdown" }), "readme.md");
    const uploadRes = await fetch(`http://127.0.0.1:${port}/api/upload?threadId=web-1`, {
      method: "POST",
      body: upload,
    });
    const file = (await uploadRes.json()) as {
      path: string;
      name: string;
      type: "markdown";
    };
    const sendRes = await fetch(`http://127.0.0.1:${port}/api/conversations/web-1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "总结附件", files: [file] }),
    });

    expect(sendRes.status).toBe(202);
    expect(receivedFiles).toEqual([{ path: file.path, name: file.name, type: file.type }]);
  });

  it("停止端点调用当前会话的取消处理器", async () => {
    let canceledId = "";
    web.onCancel((conversationId) => {
      canceledId = conversationId;
      return true;
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/conversations/web-1/cancel`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(canceledId).toBe("web-1");
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

describe("WebChannel 会话附件与 runtime 目录统一", () => {
  let db: Database.Database;
  let tmp: string;

  afterEach(() => {
    web?.stop();
    db?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("上传文件进入用户 runtime/attachments，并可发送、浏览和预览", async () => {
    tmp = mkdtempSync(join(tmpdir(), "web-runtime-upload-"));
    db = new Database(":memory:");
    const userStore = new SqliteUserStore(db, {
      adminExternalIds: new Set(),
      usersDir: join(tmp, "users"),
    });
    userStore.migrate();
    const conversationStore = new SqliteConversationStore(db);
    conversationStore.migrate();
    const sessionStore = new JwtSessionStore(db, "test-secret");
    sessionStore.migrate();
    const user = await userStore.getOrCreateByIdentity("internal", "runtime-u", "用户");
    const conversation = await conversationStore.create(user.id, "web", "附件测试");
    const token = (await sessionStore.create(user.id)).token;
    const fileBrowser = new LocalFileBrowser({ userStore, conversationStore, workspaceDir: tmp });
    let receivedPath = "";
    web = new WebChannel({
      port: 0,
      workspaceDir: tmp,
      userStore,
      conversationStore,
      sessionStore,
      fileBrowser,
    });
    web.onMessage((message) => {
      receivedPath = message.files?.[0]?.path ?? "";
    });
    await web.ready();
    const port = web.boundPort ?? 0;

    const form = new FormData();
    form.append("file", new Blob(["# runtime"], { type: "text/markdown" }), "readme.md");
    const upload = await fetch(`http://127.0.0.1:${port}/api/upload?threadId=${conversation.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    expect(upload.status).toBe(200);
    const file = (await upload.json()) as {
      path: string;
      name: string;
      type: "markdown";
      url: string;
    };
    expect(file.path).toContain(join("sessions", conversation.id, "workspace", "attachments", ""));

    const send = await fetch(
      `http://127.0.0.1:${port}/api/conversations/${conversation.id}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "分析附件", files: [file] }),
      },
    );
    expect(send.status).toBe(202);
    expect(receivedPath).toBe(file.path);

    const tree = await fetch(
      `http://127.0.0.1:${port}/api/files/tree?scope=runtime&conversationId=${conversation.id}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const treeBody = (await tree.json()) as {
      nodes: Array<{ children?: Array<{ name: string; children?: Array<{ name: string }> }> }>;
    };
    const attachments = treeBody.nodes[0]?.children?.find((node) => node.name === "attachments");
    expect(attachments?.children?.some((node) => node.name.endsWith("readme.md"))).toBe(true);

    const preview = await fetch(`http://127.0.0.1:${port}${file.url}`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toBe("# runtime");
  });
});

describe("WebChannel Git 对话前置权限门", () => {
  it("未授权返回 428，且不持久化消息或调用 handler", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "web-git-gate-"));
    const db = new Database(":memory:");
    const userStore = new SqliteUserStore(db, {
      adminExternalIds: new Set(),
      usersDir: join(tmp, "users"),
    });
    userStore.migrate();
    const conversationStore = new SqliteConversationStore(db);
    conversationStore.migrate();
    const sessionStore = new JwtSessionStore(db, "test-secret");
    sessionStore.migrate();
    const agentStore = new SqliteAgentStore(db, createSecretCipher("test"));
    agentStore.migrate();
    const user = await userStore.getOrCreateByIdentity("internal", "git-user", "用户");
    const agent = await agentStore.create({
      ownerId: user.id,
      name: "Git Agent",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      gitRepositories: [
        {
          id: "repo-1",
          name: "private",
          provider: "github",
          url: "https://github.com/acme/private.git",
          required: true,
          shallow: true,
          syncMode: "fastForward",
        },
      ],
      llm: {},
    });
    const conversation = await conversationStore.createWithAgent(user.id, "web", "Git", agent.id);
    const token = (await sessionStore.create(user.id)).token;
    const add = vi.fn(async () => undefined);
    const handler = vi.fn();
    const gitAccessGate = {
      check: vi.fn(async () => ({
        ready: false,
        materializeItems: [],
        requirements: [
          {
            provider: "github",
            reason: "connection_missing",
            repositories: [{ id: "repo-1", name: "private", fingerprint: "github:acme/private" }],
          },
        ],
      })),
    } as unknown as GitAccessGate;
    web = new WebChannel({
      port: 0,
      workspaceDir: tmp,
      userStore,
      conversationStore,
      sessionStore,
      agentStore,
      gitAccessGate,
      messageStore: { add } as never,
    });
    web.onMessage(handler);
    await web.ready();

    const response = await fetch(
      `http://127.0.0.1:${web.boundPort}/api/conversations/${conversation.id}/messages`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "开始任务" }),
      },
    );

    expect(response.status).toBe(428);
    expect((await response.json()) as object).toMatchObject({ code: "GIT_AUTH_REQUIRED" });
    expect(add).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    db.close();
    rmSync(tmp, { recursive: true, force: true });
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

async function startWebWithAgents(
  opts: { presets?: LlmPreset[]; skillPaths?: string[] } = {},
): Promise<{
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

describe("WebChannel /api/agents 分享", () => {
  it("owner 开启分享返回 url；by-share 公开不泄配置", async () => {
    const { port, token, userId, agentStore } = await startWebWithAgents();
    const a = await agentStore.create({
      ownerId: userId,
      name: "A",
      skills: ["s"],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [{ name: "m", type: "http", url: "https://x", env: { K: "V" } }],
      llm: {},
    });
    const r = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}/share`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const j = (await r.json()) as { token: string; url: string };
    expect(typeof j.token).toBe("string");
    expect(j.url).toBe(`/share/${j.token}`);

    // 公开 by-share：无 token，只回精简字段
    const pub = await fetch(`http://127.0.0.1:${port}/api/agents/by-share/${j.token}`);
    const pj = (await pub.json()) as { name: string; skills?: unknown; mcpServers?: unknown };
    expect(pj.name).toBe("A");
    expect(pj.skills).toBeUndefined();
    expect(pj.mcpServers).toBeUndefined();
  });

  it("非 owner 不能开分享 → 403", async () => {
    const { port, token, agentStore } = await startWebWithAgents();
    const a = await agentStore.create({
      ownerId: "someone-else",
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
    });
    const r = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}/share`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(r.status).toBe(403);
  });

  it("accept-share 幂等授权，建 (visitor,agent) 会话", async () => {
    const { port, token, agentShareStore, agentStore } = await startWebWithAgents();
    const a = await agentStore.create({
      ownerId: "owner",
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
    });
    const share = await agentShareStore.enableShare(a.id);
    const r1 = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}/accept-share`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ token: share.token }),
    });
    const j1 = (await r1.json()) as { conversation: { id: string; agentId: string } };
    expect(j1.conversation.agentId).toBe(a.id);
    // 再 accept 幂等
    const r2 = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}/accept-share`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ token: share.token }),
    });
    const j2 = (await r2.json()) as { conversation: { id: string } };
    expect(j2.conversation.id).toBe(j1.conversation.id);
  });

  it("关闭分享后 accept-share → 403", async () => {
    const { port, token, agentShareStore, agentStore } = await startWebWithAgents();
    const a = await agentStore.create({
      ownerId: "owner",
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
    });
    const share = await agentShareStore.enableShare(a.id);
    await agentShareStore.disableShare(a.id);
    const r = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}/accept-share`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ token: share.token }),
    });
    expect(r.status).toBe(403);
  });

  it("隔离执行 + 撤销阻断：visitor accept → 有自己的会话 → 撤销后 /conversation 403", async () => {
    const { port, token, userId, agentShareStore, agentStore } = await startWebWithAgents();
    const a = await agentStore.create({
      ownerId: "owner",
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      llm: {},
    });
    const share = await agentShareStore.enableShare(a.id);

    // visitor accept-share → 授权 + 建立自己的会话
    const acc = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}/accept-share`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ token: share.token }),
    });
    const accJson = (await acc.json()) as { conversation: { id: string; agentId: string } };
    expect(accJson.conversation.agentId).toBe(a.id);
    // 授权记录在 visitor 名下（隔离：grant 绑定 visitor userId）
    expect(await agentShareStore.isGranted(a.id, userId)).toBe(true);

    // visitor 可进入该 agent 的会话
    const conv = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}/conversation`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const convJson = (await conv.json()) as { id: string };
    expect(convJson.id).toBe(accJson.conversation.id);

    // owner 撤销 visitor 授权
    await agentShareStore.removeGrant(a.id, userId);
    expect(await agentShareStore.isGranted(a.id, userId)).toBe(false);

    // 撤销后 visitor 再访问该 agent 会话 → 403
    const blocked = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}/conversation`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(blocked.status).toBe(403);
  });
});
