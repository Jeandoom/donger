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
import { SqliteAgentCallbackStore } from "../../src/adapters/sqlite-agent-callback-store.js";
import { SqliteAgentShareStore } from "../../src/adapters/sqlite-agent-share-store.js";
import { SqliteAgentStore } from "../../src/adapters/sqlite-agent-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteMessageStore } from "../../src/adapters/sqlite-message-store.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { resolveStaticFile, WebChannel } from "../../src/adapters/web-channel.js";
import type { LlmPreset } from "../../src/config.js";
import type { AgentPermissionMode } from "../../src/domain/permission-mode.js";
import type { PackSkill, SkillPack } from "../../src/domain/skill-pack.js";
import type { GitAccessGate } from "../../src/orchestrator/git-access-gate.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";
import { createTestModuleConfigStore } from "../util/module-config-test-helper.js";

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

  it("有 dist 时，public 图标等真实文件直返", () => {
    write(root, "dist/index.html", "built");
    write(root, "dist/favicon.ico", "ico");
    write(root, "dist/pwa-icon.svg", "svg");
    write(root, "dist/icons/nested.png", "png");
    expect(resolveStaticFile(root, "/favicon.ico")?.absPath).toBe(
      join(root, "dist", "favicon.ico"),
    );
    expect(resolveStaticFile(root, "/pwa-icon.svg")?.absPath).toBe(
      join(root, "dist", "pwa-icon.svg"),
    );
    expect(resolveStaticFile(root, "/icons/nested.png")?.absPath).toBe(
      join(root, "dist", "icons", "nested.png"),
    );
  });

  it("有 dist 时，路径穿越被拦截并走 SPA fallback", () => {
    write(root, "dist/index.html", "built");
    write(root, "secret.txt", "top-secret");
    const r = resolveStaticFile(root, "/../secret.txt");
    expect(r?.absPath).toBe(join(root, "dist", "index.html"));
  });

  it("无 dist 时，/ 返回 null（未构建）", () => {
    const r = resolveStaticFile(root, "/");
    expect(r).toBeNull();
  });

  it("无 dist 时，未知路径返回 null", () => {
    const r = resolveStaticFile(root, "/agents");
    expect(r).toBeNull();
  });

  // 2026-09-18 生产实测：GET /assets/（目录）曾直通 readFileSync 抛 EISDIR 打死进程
  it("有 dist 时，/assets/ 目录请求返回 null（404），不得把目录当文件托管", () => {
    write(root, "dist/index.html", "built");
    write(root, "dist/assets/app.js", "// js");
    expect(resolveStaticFile(root, "/assets/")).toBeNull();
  });

  it("有 dist 时，任意存在的子目录路径绝不指向目录本身", () => {
    write(root, "dist/index.html", "built");
    write(root, "dist/icons/nested.png", "png");
    // /icons 是目录但非 /assets 前缀 → SPA fallback（指向真实文件，安全）
    const spa = resolveStaticFile(root, "/icons");
    expect(spa?.absPath).toBe(join(root, "dist", "index.html"));
    // /icons/ 带尾斜杠 → resolveRealFile 命中目录须判非文件拒绝 → 同样 SPA fallback
    const spa2 = resolveStaticFile(root, "/icons/");
    expect(spa2?.absPath).toBe(join(root, "dist", "index.html"));
    // 真实文件不受影响
    expect(resolveStaticFile(root, "/icons/nested.png")?.absPath).toBe(
      join(root, "dist", "icons", "nested.png"),
    );
  });
});

let web: WebChannel;
afterEach(async () => {
  await web?.stop();
});

async function startWith(usageStore: InMemoryUsageStore): Promise<number> {
  const tmp = mkdtempSync(join(tmpdir(), "web-ws-"));
  web = new WebChannel({ port: 0, workspaceDir: tmp, usageStore });
  web.onMessage(() => {});
  await web.ready();
  const port = web.boundPort;
  if (!port) throw new Error("server not listening");
  return port;
}

async function startQrChannel(
  publicBaseUrl?: string,
  dingtalkLoginRedirectUri?: string,
): Promise<number> {
  const tmp = mkdtempSync(join(tmpdir(), "web-qr-"));
  const db = new Database(":memory:");
  const moduleConfigStore = createTestModuleConfigStore(db);
  moduleConfigStore.putDingTalk({
    appKey: "ding-app",
    appSecret: "secret",
    ...(dingtalkLoginRedirectUri ? { redirectUriOverride: dingtalkLoginRedirectUri } : {}),
  });
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmp,
    moduleConfigStore,
    publicBaseUrl,
  });
  web.onMessage(() => {});
  await web.ready();
  const port = web.boundPort;
  if (!port) throw new Error("server not listening");
  return port;
}

describe("WebChannel GET /api/auth/qrcode-url", () => {
  it("配置 PUBLIC_BASE_URL 时优先用其生成钉钉回调", async () => {
    const port = await startQrChannel("https://example.com:3333");
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/qrcode-url`);
    const body = (await response.json()) as { url: string };
    expect(new URL(body.url).searchParams.get("redirect_uri")).toBe(
      "https://example.com:3333/api/auth/dingtalk/callback",
    );
  });

  it("未配置 PUBLIC_BASE_URL 时使用监听 host 和实际端口", async () => {
    const port = await startQrChannel();
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/qrcode-url`);
    const body = (await response.json()) as { url: string };
    expect(new URL(body.url).searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:${port}/api/auth/dingtalk/callback`,
    );
  });

  it("配置 DINGTALK_LOGIN_REDIRECT_URI 时优先于 PUBLIC_BASE_URL", async () => {
    const port = await startQrChannel(
      "https://example.com:3333",
      "https://ddns.example.com:8443/api/auth/dingtalk/callback",
    );
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/qrcode-url`);
    const body = (await response.json()) as { url: string };
    expect(new URL(body.url).searchParams.get("redirect_uri")).toBe(
      "https://ddns.example.com:8443/api/auth/dingtalk/callback",
    );
  });
});

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

  afterEach(async () => {
    await web?.stop();
    db?.close();
  });

  async function createAuthChannel(cliToken?: string): Promise<number> {
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

    const { SqliteConversationStore } = await import(
      "../../src/adapters/sqlite-conversation-store.js"
    );
    const conversationStore = new SqliteConversationStore(db);
    conversationStore.migrate();

    const tmp = mkdtempSync(join(tmpdir(), "web-auth-"));
    web = new WebChannel({
      port: 0,
      workspaceDir: tmp,
      sessionStore,
      userStore,
      conversationStore,
      cliToken,
    });
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
  async function createSessionToken(): Promise<{ token: string; convId: string }> {
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
    // 属主会话：stream/messages 等会话路由走 owner 守卫，须用真实会话 id
    const { SqliteConversationStore } = await import(
      "../../src/adapters/sqlite-conversation-store.js"
    );
    const convStore = new SqliteConversationStore(db);
    convStore.migrate();
    const conv = await convStore.create(user.id, "web", "stream-test");
    const { token } = await sessionStore.create(user.id);
    return { token, convId: conv.id };
  }

  it("GET /api/conversations/:id/stream 无 token → 401", async () => {
    const port = await createAuthChannel();
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations/abc-123/stream`);
    expect(res.status).toBe(401);
  });

  it("GET /api/conversations/:id/stream?token=<有效> → 200 text/event-stream", async () => {
    const port = await createAuthChannel();
    const { token, convId } = await createSessionToken();
    const res = await fetch(
      `http://127.0.0.1:${port}/api/conversations/${convId}/stream?token=${token}`,
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

  it("POST /api/approvals/:id/respond 无 token → 401（审批决议必须认证）", async () => {
    const port = await createAuthChannel();
    const res = await fetch(`http://127.0.0.1:${port}/api/approvals/gate-xyz/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/credentials/:reqId/submit 未登记路由 → 404（fail-closed；该路由已随凭证集体系移除）", async () => {
    const port = await createAuthChannel();
    const res = await fetch(`http://127.0.0.1:${port}/api/credentials/req-xyz/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: { API_KEY: "v" } }),
    });
    expect(res.status).toBe(404);
  });

  /** 事件回放专用通道：带 sessionStore + conversationStore + auditStore，预置属主用户/会话/审计事件 */
  async function createEventsChannel(): Promise<{
    port: number;
    token: string;
    convId: string;
    otherToken: string;
  }> {
    db = new Database(":memory:");
    const { JwtSessionStore } = await import("../../src/adapters/jwt-session-store.js");
    const sessionStore = new JwtSessionStore(db, "test-secret");
    sessionStore.migrate();
    const { SqliteUserStore } = await import("../../src/adapters/sqlite-user-store.js");
    const userStore = new SqliteUserStore(db, {
      adminExternalIds: new Set(),
      usersDir: mkdtempSync(join(tmpdir(), "web-events-users-")),
    });
    userStore.migrate();
    const owner = await userStore.getOrCreateByIdentity("internal", "events-owner", "属主");
    const { token } = await sessionStore.create(owner.id);
    const other = await userStore.getOrCreateByIdentity("internal", "events-other", "旁人");
    const otherToken = (await sessionStore.create(other.id)).token;

    const { SqliteConversationStore } = await import(
      "../../src/adapters/sqlite-conversation-store.js"
    );
    const convStore = new SqliteConversationStore(db);
    convStore.migrate();
    await convStore.create(owner.id, "web", "事件回放");
    const convId = (await convStore.listByUser(owner.id))[0]?.id;
    if (!convId) throw new Error("no conversation");

    const { InMemoryAuditStore } = await import("../../src/adapters/in-memory-audit-store.js");
    // L2 visible 查询需属主源（规格 §4）
    const auditStore = new InMemoryAuditStore({
      conversationOwner: async (id) => (await convStore.get(id))?.userId,
    });
    const mk = (id: string, type: "text" | "llm_input" | "tool_use") => ({
      id,
      conversationId: convId,
      taskId: "t1",
      userId: owner.id,
      seq: 0,
      type,
      text: type === "text" ? "hi" : undefined,
      recordedAt: "t0",
    });
    await auditStore.record(mk("e1", "text"));
    await auditStore.record(mk("e2", "llm_input"));
    await auditStore.record(mk("e3", "tool_use"));

    const tmp = mkdtempSync(join(tmpdir(), "web-events-"));
    web = new WebChannel({
      port: 0,
      workspaceDir: tmp,
      sessionStore,
      userStore,
      conversationStore: convStore,
      auditStore,
    });
    web.onMessage(() => {});
    await web.ready();
    const port = web.boundPort;
    if (!port) throw new Error("no port");
    return { port, token, convId, otherToken };
  }

  it("GET /api/conversations/:id/events 无 token → 401", async () => {
    const { port, convId } = await createEventsChannel();
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/events`);
    expect(res.status).toBe(401);
  });

  it("GET /api/conversations/:id/events 属主可回放，llm_input/llm_output 被过滤", async () => {
    const { port, token, convId } = await createEventsChannel();
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ type: string }> };
    expect(body.events.map((e) => e.type)).toEqual(["text", "tool_use"]);
  });

  it("GET /api/conversations/:id/events?light=1 命中路由并截断工具字段", async () => {
    const { port, token, convId } = await createEventsChannel();
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/events?light=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ type: string }> };
    expect(body.events.map((e) => e.type)).toEqual(["text", "tool_use"]);
  });

  it("GET /api/conversations/:id/events 非属主 → 403", async () => {
    const { port, convId, otherToken } = await createEventsChannel();
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/events`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    expect(res.status).toBe(403);
  });

  /** 实时执行状态专用通道：带 sessionStore + conversationStore + 可配置 activityGetter */
  async function createActivityChannel(
    getter?: (conversationId: string) => unknown,
  ): Promise<{ port: number; token: string; convId: string; otherToken: string }> {
    db = new Database(":memory:");
    const { JwtSessionStore } = await import("../../src/adapters/jwt-session-store.js");
    const sessionStore = new JwtSessionStore(db, "test-secret");
    sessionStore.migrate();
    const { SqliteUserStore } = await import("../../src/adapters/sqlite-user-store.js");
    const userStore = new SqliteUserStore(db, {
      adminExternalIds: new Set(),
      usersDir: mkdtempSync(join(tmpdir(), "web-activity-users-")),
    });
    userStore.migrate();
    const owner = await userStore.getOrCreateByIdentity("internal", "activity-owner", "属主");
    const { token } = await sessionStore.create(owner.id);
    const other = await userStore.getOrCreateByIdentity("internal", "activity-other", "旁人");
    const otherToken = (await sessionStore.create(other.id)).token;

    const { SqliteConversationStore } = await import(
      "../../src/adapters/sqlite-conversation-store.js"
    );
    const convStore = new SqliteConversationStore(db);
    convStore.migrate();
    await convStore.create(owner.id, "web", "执行状态");
    const convId = (await convStore.listByUser(owner.id))[0]?.id;
    if (!convId) throw new Error("no conversation");

    const tmp = mkdtempSync(join(tmpdir(), "web-activity-"));
    web = new WebChannel({
      port: 0,
      workspaceDir: tmp,
      sessionStore,
      userStore,
      conversationStore: convStore,
      ...(getter ? { activityGetter: getter as never } : {}),
    });
    web.onMessage(() => {});
    await web.ready();
    const port = web.boundPort;
    if (!port) throw new Error("no port");
    return { port, token, convId, otherToken };
  }

  it("GET /api/conversations/:id/activity 未装配 activityGetter → 503", async () => {
    const { port, convId, token } = await createActivityChannel();
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/activity`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(503);
  });

  it("GET /api/conversations/:id/activity 属主可见快照，空闲 204", async () => {
    const { port, token, convId } = await createActivityChannel((id) =>
      id ? { state: "tool", toolName: "Bash", startedAt: "t", lastEventAt: "t" } : undefined,
    );
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/activity`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activity: { state: string; toolName?: string } };
    expect(body.activity.state).toBe("tool");
    expect(body.activity.toolName).toBe("Bash");

    const {
      port: port2,
      token: token2,
      convId: convId2,
    } = await createActivityChannel(() => undefined);
    const idle = await fetch(`http://127.0.0.1:${port2}/api/conversations/${convId2}/activity`, {
      headers: { Authorization: `Bearer ${token2}` },
    });
    expect(idle.status).toBe(204);
  });

  it("GET /api/conversations/:id/activity 非属主 → 403；无 token → 401", async () => {
    const { port, convId, otherToken } = await createActivityChannel(() => ({
      state: "text",
      startedAt: "t",
      lastEventAt: "t",
    }));
    const forbidden = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/activity`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    expect(forbidden.status).toBe(403);
    const unauthorized = await fetch(
      `http://127.0.0.1:${port}/api/conversations/${convId}/activity`,
    );
    expect(unauthorized.status).toBe(401);
  });

  it("POST /api/auth/exchange 未配置 CLI_TOKEN → 403", async () => {
    const port = await createAuthChannel();
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "whatever" }),
    });
    expect(res.status).toBe(403);
  });

  it("POST /api/auth/exchange 密钥错误 → 403", async () => {
    const port = await createAuthChannel("right-secret");
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-secret" }),
    });
    expect(res.status).toBe(403);
  });

  it("POST /api/auth/exchange 密钥正确 → 签发可用的 JWT", async () => {
    const port = await createAuthChannel("right-secret");
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "right-secret" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { id: string; name: string } };
    expect(body.token).toBeTruthy();
    expect(body.user.name).toBe("cli-admin");
    // 换来的 JWT 能访问认证路由
    const me = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(me.status).toBe(200);
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
    const auditStore = new InMemoryAuditStore({
      conversationOwner: async (id) => (await conversationStore.get(id))?.userId,
    });
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

describe("WebChannel POST /api/llm/debug", () => {
  it("使用选中的模型调用调试 runner", async () => {
    const run = vi.fn(async (input: string, llm: { model: string }) => ({
      output: `echo:${input}`,
      model: llm.model,
    }));
    web = new WebChannel({
      port: 0,
      workspaceDir: mkdtempSync(join(tmpdir(), "web-")),
      llm: { model: "default", baseUrl: "https://default", authToken: "secret" },
      llmDebugRunner: { run },
      agentMeta: {
        presets: [{ id: "p1", name: "测试模型", model: "m1", baseUrl: "https://m1" }],
        skillPaths: [],
      },
    });
    web.onMessage(() => {});
    await web.ready();
    const port = web.boundPort;
    if (!port) throw new Error("no port");
    const res = await fetch(`http://127.0.0.1:${port}/api/llm/debug`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "edited input", presetId: "p1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ output: "echo:edited input", model: "m1" });
    expect(run).toHaveBeenCalledWith("edited input", {
      model: "m1",
      baseUrl: "https://m1",
      authToken: "secret",
    });
  });
});

describe("WebChannel GET /api/audit/conversations/:id", () => {
  it("返回按轮分组的详情", async () => {
    const db = new Database(":memory:");
    const conversationStore = new SqliteConversationStore(db);
    conversationStore.migrate();
    const created = await conversationStore.create("u1", "web", "t");
    const taskStore = new InMemoryTaskStore();
    const auditStore = new InMemoryAuditStore({
      conversationOwner: async (id) => (await conversationStore.get(id))?.userId,
    });
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
  let convId: string;
  let receivedFiles: Array<{ path: string; name: string; type: string }> | undefined;
  let uploadDb: Database.Database;
  let sessionStore: JwtSessionStore;
  let authHeaders: Record<string, string>;

  beforeEach(async () => {
    webTmp = mkdtempSync(join(tmpdir(), "web-upload-"));
    // 会话属主固定为本地免认证 viewer id "local"；挂 sessionStore 后统一鉴权层生效，
    // 本 describe 所有请求都带属主 token（/uploads/ 回读本就强制，规格 M4）
    uploadDb = new Database(":memory:");
    const { SqliteConversationStore } = await import(
      "../../src/adapters/sqlite-conversation-store.js"
    );
    const convStore = new SqliteConversationStore(uploadDb);
    convStore.migrate();
    convId = (await convStore.create("local", "web", "upload-test")).id;
    sessionStore = new JwtSessionStore(uploadDb, "test-secret");
    sessionStore.migrate();
    const token = (await sessionStore.create("local")).token;
    authHeaders = { authorization: `Bearer ${token}` };
    web = new WebChannel({
      port: 0,
      workspaceDir: webTmp,
      conversationStore: convStore,
      sessionStore,
    });
    web.onMessage((message) => {
      receivedFiles = message.files;
    });
    await web.ready();
    const p = web.boundPort;
    if (!p) throw new Error("no port");
    port = p;
  });

  afterEach(async () => {
    await web?.stop();
    uploadDb?.close();
    rmSync(webTmp, { recursive: true, force: true });
  });

  it("上传图片成功", async () => {
    const body = new FormData();
    const blob = new Blob(["fake-png"], { type: "image/png" });
    body.append("file", blob, "test.png");
    const res = await fetch(`http://127.0.0.1:${port}/api/upload?threadId=${convId}`, {
      method: "POST",
      headers: authHeaders,
      body,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { path: string; name: string; type: string };
    expect(j.name).toBe("test.png");
    expect(j.type).toBe("image");
    expect(j.path).toContain("sessions");
    expect(j.path).toContain(convId);
  });

  it("上传 .md 文件成功", async () => {
    const body = new FormData();
    body.append("file", new Blob(["# Hello"], { type: "text/markdown" }), "readme.md");
    const res = await fetch(`http://127.0.0.1:${port}/api/upload?threadId=${convId}`, {
      method: "POST",
      headers: authHeaders,
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
    const uploadRes = await fetch(`http://127.0.0.1:${port}/api/upload?threadId=${convId}`, {
      method: "POST",
      headers: authHeaders,
      body: upload,
    });
    const file = (await uploadRes.json()) as {
      path: string;
      name: string;
      type: "markdown";
    };
    const sendRes = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
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
    const response = await fetch(`http://127.0.0.1:${port}/api/conversations/${convId}/cancel`, {
      method: "POST",
      headers: authHeaders,
    });

    expect(response.status).toBe(200);
    expect(canceledId).toBe(convId);
  });

  it("上传任意类型文件成功（document）", async () => {
    const body = new FormData();
    body.append("file", new Blob(["<xml/>"], { type: "text/xml" }), "test.xml");
    const res = await fetch(`http://127.0.0.1:${port}/api/upload?threadId=${convId}`, {
      method: "POST",
      headers: authHeaders,
      body,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { path: string; name: string; type: string };
    expect(j.name).toBe("test.xml");
    expect(j.type).toBe("document");
  });

  it("超过大小上限返回 400", async () => {
    const body = new FormData();
    body.append(
      "file",
      new Blob([Buffer.alloc(20 * 1024 * 1024 + 1)], { type: "application/octet-stream" }),
      "big.bin",
    );
    const res = await fetch(`http://127.0.0.1:${port}/api/upload?threadId=${convId}`, {
      method: "POST",
      headers: authHeaders,
      body,
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toContain("20MB");
  });

  it("文件名含非法字符时消毒落盘", async () => {
    const body = new FormData();
    body.append("file", new Blob(["hi"], { type: "text/plain" }), "re:o?port<v2>.txt");
    const res = await fetch(`http://127.0.0.1:${port}/api/upload?threadId=${convId}`, {
      method: "POST",
      headers: authHeaders,
      body,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { path: string; name: string; type: string };
    expect(j.name).toBe("re_o_port_v2_.txt");
    // Windows 非法名会直接写失败，消毒后必须真实落盘
    expect(existsSync(j.path)).toBe(true);
  });

  it("中文文件名按 UTF-8 保真落盘（不 mojibake）", async () => {
    const body = new FormData();
    body.append(
      "file",
      new Blob(["PK"], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      "季度报表.xlsx",
    );
    const res = await fetch(`http://127.0.0.1:${port}/api/upload?threadId=${convId}`, {
      method: "POST",
      headers: authHeaders,
      body,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { path: string; name: string; type: string };
    expect(j.name).toBe("季度报表.xlsx");
    expect(j.type).toBe("document");
    expect(existsSync(j.path)).toBe(true);
  });

  it("可脚本化附件回读降级安全：html 按纯文本、zip 强制 attachment", async () => {
    const htmlBody = new FormData();
    htmlBody.append(
      "file",
      new Blob(["<script>alert(1)</script>"], { type: "text/html" }),
      "x.html",
    );
    const htmlUpload = await fetch(`http://127.0.0.1:${port}/api/upload?threadId=${convId}`, {
      method: "POST",
      headers: authHeaders,
      body: htmlBody,
    });
    const htmlFile = (await htmlUpload.json()) as { url: string };
    const htmlRes = await fetch(`http://127.0.0.1:${port}${htmlFile.url}`, {
      headers: authHeaders,
    });
    expect(htmlRes.status).toBe(200);
    // html 按 text/plain 内联 + nosniff：浏览器按纯文本渲染，脚本不执行
    expect(htmlRes.headers.get("content-type")).toContain("text/plain");
    expect(htmlRes.headers.get("x-content-type-options")).toBe("nosniff");

    const zipBody = new FormData();
    zipBody.append("file", new Blob(["PK"], { type: "application/zip" }), "y.zip");
    const zipUpload = await fetch(`http://127.0.0.1:${port}/api/upload?threadId=${convId}`, {
      method: "POST",
      headers: authHeaders,
      body: zipBody,
    });
    const zipFile = (await zipUpload.json()) as { url: string };
    const zipRes = await fetch(`http://127.0.0.1:${port}${zipFile.url}`, {
      headers: authHeaders,
    });
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(zipRes.headers.get("content-disposition")).toContain("attachment");

    const mdBody = new FormData();
    mdBody.append("file", new Blob(["# hi"], { type: "text/markdown" }), "y.md");
    const mdUpload = await fetch(`http://127.0.0.1:${port}/api/upload?threadId=${convId}`, {
      method: "POST",
      headers: authHeaders,
      body: mdBody,
    });
    const mdFile = (await mdUpload.json()) as { url: string };
    const mdRes = await fetch(`http://127.0.0.1:${port}${mdFile.url}`, { headers: authHeaders });
    expect(mdRes.status).toBe(200);
    expect(mdRes.headers.get("content-disposition")).toContain("inline");
  });

  it("无 threadId 返回 400", async () => {
    const body = new FormData();
    body.append("file", new Blob(["fake"], { type: "image/png" }), "test.png");
    const res = await fetch(`http://127.0.0.1:${port}/api/upload`, {
      method: "POST",
      headers: authHeaders,
      body,
    });
    expect(res.status).toBe(400);
  });

  it("非 multipart 返回 400", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/upload?threadId=${convId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("WebChannel 会话附件与 runtime 目录统一", () => {
  let db: Database.Database;
  let tmp: string;

  afterEach(async () => {
    await web?.stop();
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
      nodes: Array<{ name: string; children?: Array<{ name: string }> }>;
    };
    // runtime 树已拍平：attachments 目录直接在顶层
    const attachments = treeBody.nodes.find((node) => node.name === "attachments");
    expect(attachments?.children?.some((node) => node.name.endsWith("readme.md"))).toBe(true);

    // 附件读取已要求属主 token（规格 M4）：url 原样无 token → 401；带 token → 200
    const denied = await fetch(`http://127.0.0.1:${port}${file.url}`);
    expect(denied.status).toBe(401);
    const preview = await fetch(
      `http://127.0.0.1:${port}${file.url}${file.url.includes("?") ? "&" : "?"}token=${token}`,
    );
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
            repositories: [
              { id: "repo-1", name: "private", fingerprint: "github.com/acme/private" },
            ],
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
  opts: {
    presets?: LlmPreset[];
    skillPaths?: string[];
    onPermissionModeChange?: (conversationId: string, mode: AgentPermissionMode) => void;
  } = {},
): Promise<{
  port: number;
  token: string;
  userId: string;
  agentStore: SqliteAgentStore;
  agentShareStore: SqliteAgentShareStore;
  skillPackStore: SqliteSkillPackStore;
  convStore: SqliteConversationStore;
  userStore: SqliteUserStore;
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
  const skillPackStore = new SqliteSkillPackStore(db);
  skillPackStore.migrate();
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
    skillPackStore,
    agentMeta: { presets: opts.presets ?? [], skillPaths: opts.skillPaths ?? [] },
    onPermissionModeChange: opts.onPermissionModeChange,
  });
  web.onMessage(() => {});
  await web.ready();
  const port = web.boundPort;
  if (!port) throw new Error("server not listening");
  return {
    port,
    token,
    userId: user.id,
    agentStore,
    agentShareStore,
    skillPackStore,
    convStore,
    userStore,
  };
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
    });
    const r = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(403);
  });

  it("详情 DTO 返回 scenario/gitAllowShellGit/version（漏传会让表单把默认值覆盖回库）", async () => {
    const { port, token, agentStore, userId } = await startWebWithAgents();
    const a = await agentStore.create({
      ownerId: userId,
      name: "SC",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      scenario: "code-dev",
      gitAllowShellGit: true,
    });
    const r = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const dto = (await r.json()) as {
      scenario?: string;
      gitAllowShellGit?: boolean;
      version?: number;
    };
    expect(dto.scenario).toBe("code-dev");
    expect(dto.gitAllowShellGit).toBe(true);
    expect(dto.version).toBe(1);
  });

  it("详情 DTO 返回 defaultPermissionMode（漏传会让编辑页刷新回落为问询并回写覆盖）", async () => {
    const { port, token, agentStore, userId } = await startWebWithAgents();
    const a = await agentStore.create({
      ownerId: userId,
      name: "PM",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      defaultPermissionMode: "full_access",
    });
    const r = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const dto = (await r.json()) as { defaultPermissionMode?: string };
    expect(dto.defaultPermissionMode).toBe("full_access");
  });

  it("PATCH/DELETE 仅 owner 可用（非 owner → 403）", async () => {
    const { port, token, agentStore } = await startWebWithAgents();
    const a = await agentStore.create({
      ownerId: "someone-else",
      name: "X",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
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

  it("meta/options 返回当前用户启用 pack 和 skill", async () => {
    const { port, token, userId, skillPackStore } = await startWebWithAgents();
    const now = new Date().toISOString();
    const pack: SkillPack = {
      id: "pack-enabled",
      userId,
      slug: "enabled-pack",
      name: "enabled-pack",
      source: { kind: "paste" },
      installedPath: ".skills/enabled-pack",
      enabled: true,
      builtin: false,
      credentials: [],
      createdAt: now,
      updatedAt: now,
    };
    const enabledSkill: PackSkill = {
      id: "skill-enabled",
      userId,
      packId: pack.id,
      name: "search-orders",
      description: "查询订单",
      relativePath: "skills/search-orders/SKILL.md",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    const disabledSkill: PackSkill = {
      ...enabledSkill,
      id: "skill-disabled",
      name: "disabled-skill",
      enabled: false,
    };
    const disabledPack: SkillPack = {
      ...pack,
      id: "pack-disabled",
      slug: "disabled-pack",
      name: "disabled-pack",
      enabled: false,
    };
    await skillPackStore.upsertPack(pack);
    await skillPackStore.upsertPack(disabledPack);
    await skillPackStore.upsertSkills(userId, pack.id, [enabledSkill, disabledSkill]);
    await skillPackStore.upsertSkills(userId, disabledPack.id, [
      { ...enabledSkill, id: "skill-disabled-pack", packId: disabledPack.id, name: "hidden-skill" },
    ]);

    const r = await fetch(`http://127.0.0.1:${port}/api/agents/meta/options`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      skills: Array<{ id: string; name: string; description?: string }>;
      skillGroups: Array<{
        key: string;
        label: string;
        kind: string;
        sourceLabel?: string;
        skills: Array<{ id: string }>;
      }>;
    };
    expect(body.skills).toContainEqual({
      id: "enabled-pack:search-orders",
      name: "search-orders",
      description: "查询订单",
    });
    expect(body.skills.map((skill) => skill.id)).not.toContain("enabled-pack:disabled-skill");
    expect(body.skills.map((skill) => skill.id)).not.toContain("disabled-pack:hidden-skill");
    // 分组视图：启用的 pack 各成一组（含来源标签），停用 pack 与停用技能不出现
    const packGroup = body.skillGroups.find((group) => group.key === "pack:pack-enabled");
    expect(packGroup).toMatchObject({
      label: "enabled-pack",
      kind: "pack",
      sourceLabel: "粘贴创建",
    });
    expect(packGroup?.skills.map((skill) => skill.id)).toEqual(["enabled-pack:search-orders"]);
    expect(body.skillGroups.map((group) => group.key)).not.toContain("pack:pack-disabled");
  });

  it("GET /:id/conversation get-or-create（幂等）", async () => {
    const { port, token, userId, agentStore } = await startWebWithAgents();
    const a = await agentStore.create({
      ownerId: userId,
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
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

  it("GET /:id/conversation 多会话时复用最近使用的（updatedAt 倒序首个）", async () => {
    const { port, token, userId, agentStore, convStore } = await startWebWithAgents();
    const a = await agentStore.create({
      ownerId: userId,
      name: "A",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
    });
    const r1 = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}/conversation`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const c1 = (await r1.json()) as { id: string };
    // 同 agent 再建一条（updatedAt 更晚）；此前实现按创建序取首个会误回 c1
    const newer = await convStore.createWithAgent(userId, "web", a.name, a.id);
    const r2 = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}/conversation`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const c2 = (await r2.json()) as { id: string };
    expect(c2.id).toBe(newer.id);
    expect(c2.id).not.toBe(c1.id);
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
    // 分享收紧：详情/版本历史属配置面，被分享者 403（对话走 /conversation 不受影响）
    const detail = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.status).toBe(403);
    const versions = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}/versions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(versions.status).toBe(403);
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

  it("duplicate：被分享者可复制，凭证类不随复制且 warnings 提示；他人无同名沿用原名", async () => {
    const { port, token, userId, agentShareStore, agentStore, userStore } =
      await startWebWithAgents();
    const owner = await userStore.getOrCreateByIdentity("internal", "dup-owner", "属主甲");
    const a = await agentStore.create({
      ownerId: owner.id,
      name: "ai-audit",
      systemPrompt: "sp",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [{ name: "m1", type: "stdio", command: "x", env: { TOKEN: "secret" } }],
      credentials: ["github_pat"],
      connectorIds: ["c1"],
      conversationScope: { enabled: true, agentIds: [owner.id], limit: 5 },
      gitRepositories: [
        {
          id: "r1",
          name: "r",
          provider: "github",
          url: "https://github.com/o/r.git",
          required: true,
          shallow: true,
          syncMode: "fastForward",
          credentialCode: "git_pat",
        },
      ],
    });
    const share = await agentShareStore.enableShare(a.id);
    await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}/accept-share`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ token: share.token }),
    });
    const dup = await fetch(`http://127.0.0.1:${port}/api/agents/${a.id}/duplicate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(dup.status).toBe(200);
    const json = (await dup.json()) as {
      id: string;
      ownerId: string;
      name: string;
      mcpServers: Array<{ env?: unknown; headers?: unknown }>;
      credentials: string[];
      connectorIds: string[];
      gitRepositories: Array<{ credentialCode?: string }>;
      conversationScope?: { agentIds: string[] };
      warnings: string[];
    };
    // 他人无同名 → 沿用原名；副本落 visitor 名下
    expect(json.name).toBe("ai-audit");
    expect(json.ownerId).toBe(userId);
    // 凭证类一律不随复制（拍板：只复制非凭证配置）
    expect(json.mcpServers[0]?.env).toBeUndefined();
    expect(json.mcpServers[0]?.headers).toBeUndefined();
    expect(json.credentials).toEqual([]);
    expect(json.connectorIds).toEqual([]);
    expect(json.gitRepositories[0]?.credentialCode).toBeUndefined();
    // 会话范围引用原主智能体，复制他人时清空
    expect(json.conversationScope?.agentIds).toEqual([]);
    expect(json.warnings.length).toBeGreaterThanOrEqual(4);
  });

  it("duplicate：无关用户 403；命名——自己加-副本、二次撞名加序号、他人同名加分享人名", async () => {
    const { port, token, userId, agentStore, agentShareStore, userStore } =
      await startWebWithAgents();
    const owner = await userStore.getOrCreateByIdentity("internal", "dup-owner2", "属主乙");
    // visitor 自己的智能体：复制 → -副本；再复制撞名 → -副本-2
    const mine = await agentStore.create({
      ownerId: userId,
      name: "tool",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
    });
    const d1 = await fetch(`http://127.0.0.1:${port}/api/agents/${mine.id}/duplicate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(d1.status).toBe(200);
    expect(((await d1.json()) as { name: string }).name).toBe("tool-副本");
    const d2 = await fetch(`http://127.0.0.1:${port}/api/agents/${mine.id}/duplicate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(((await d2.json()) as { name: string }).name).toBe("tool-副本-2");

    // 他人智能体：visitor 已有同名 → 原名-分享人名
    const others = await agentStore.create({
      ownerId: owner.id,
      name: "tool",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
    });
    const share = await agentShareStore.enableShare(others.id);
    await fetch(`http://127.0.0.1:${port}/api/agents/${others.id}/accept-share`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ token: share.token }),
    });
    const d3 = await fetch(`http://127.0.0.1:${port}/api/agents/${others.id}/duplicate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(((await d3.json()) as { name: string }).name).toBe("tool-属主乙");

    // 分享关闭后 isGranted=false → 复制 403（canUseAgent 不再放行）
    await agentShareStore.disableShare(others.id);
    const d4 = await fetch(`http://127.0.0.1:${port}/api/agents/${others.id}/duplicate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(d4.status).toBe(403);
  });
});

describe("WebChannel 工作流模块 CRUD (/api/triggers|workflows|loops)", () => {
  let web: WebChannel;
  let db: Database.Database;

  afterEach(async () => {
    await web?.stop();
    db?.close();
  });

  async function startWorkflowChannel(): Promise<{
    port: number;
    token: string;
    token2: string;
  }> {
    db = new Database(":memory:");
    const sessionStore = new JwtSessionStore(db, "test-secret");
    sessionStore.migrate();
    const userStore = new SqliteUserStore(db, {
      adminExternalIds: new Set(),
      usersDir: mkdtempSync(join(tmpdir(), "web-wf-users-")),
    });
    userStore.migrate();
    const user1 = await userStore.getOrCreateByIdentity("internal", "wf-staff", "工作流测试");
    const user2 = await userStore.getOrCreateByIdentity("internal", "wf-staff-2", "工作流测试 2");
    const { token } = await sessionStore.create(user1.id);
    const { token: token2 } = await sessionStore.create(user2.id);

    const { SqliteTriggerStore } = await import("../../src/adapters/sqlite-trigger-store.js");
    const { SqliteWorkflowStore } = await import("../../src/adapters/sqlite-workflow-store.js");
    const { SqliteLoopStore } = await import("../../src/adapters/sqlite-loop-store.js");
    const triggerStore = new SqliteTriggerStore(db);
    triggerStore.migrate();
    const workflowStore = new SqliteWorkflowStore(db);
    workflowStore.migrate();
    const loopStore = new SqliteLoopStore(db);
    loopStore.migrate();

    const tmp = mkdtempSync(join(tmpdir(), "web-wf-"));
    // ponytail: 最小 loopRunner mock —— 测试只走 /run 校验路径，fire/testTrigger 不会真正被调用
    const loopRunner = {
      fire: vi.fn().mockResolvedValue(undefined),
      testTrigger: vi.fn().mockResolvedValue({ matched: true, sourceOutput: "x" }),
      pump: vi.fn(),
    } as unknown as import("../../src/orchestrator/loop-runner.js").LoopRunner;
    web = new WebChannel({
      port: 0,
      workspaceDir: tmp,
      sessionStore,
      userStore,
      triggerStore,
      workflowStore,
      loopStore,
      loopRunner,
    });
    web.onMessage(() => {});
    await web.ready();
    const port = web.boundPort;
    if (!port) throw new Error("no port");
    return { port, token, token2 };
  }

  it("trigger / workflow / loop 全链路 CRUD + 删除保护", async () => {
    const { port, token } = await startWorkflowChannel();
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    // trigger CREATE
    const triggerRes = await fetch(`http://127.0.0.1:${port}/api/triggers`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "T1",
        type: "scheduler",
        scheduler: {
          cron: "0 9 * * *",
          source: { type: "http", url: "https://example.com", method: "GET" },
          matcher: { kind: "always" },
        },
      }),
    });
    expect(triggerRes.status).toBe(201);
    const trigger = (await triggerRes.json()) as { id: string };
    expect(trigger.id).toBeTruthy();

    // trigger LIST
    const listRes = await fetch(`http://127.0.0.1:${port}/api/triggers`, { headers: auth });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { triggers: { id: string }[] };
    expect(list.triggers).toHaveLength(1);

    // workflow CREATE（引用上面的 trigger）
    const wfRes = await fetch(`http://127.0.0.1:${port}/api/workflows`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "W1", triggerId: trigger.id, agentId: "a1" }),
    });
    expect(wfRes.status).toBe(201);
    const workflow = (await wfRes.json()) as { id: string; promptTemplate: string };
    expect(workflow.promptTemplate).toBe("{{triggerOutput}}"); // 默认值生效

    // trigger DELETE 因被 workflow 引用 → 409
    const delConflict = await fetch(`http://127.0.0.1:${port}/api/triggers/${trigger.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(delConflict.status).toBe(409);

    // loop CREATE（引用 workflow）
    const loopRes = await fetch(`http://127.0.0.1:${port}/api/loops`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "L1", workflowId: workflow.id }),
    });
    expect(loopRes.status).toBe(201);
    const loop = (await loopRes.json()) as { id: string; enabled: boolean };
    expect(loop.enabled).toBe(false); // 默认值

    // loop enable
    const enableRes = await fetch(`http://127.0.0.1:${port}/api/loops/${loop.id}/enable`, {
      method: "POST",
      headers: auth,
    });
    expect(enableRes.status).toBe(200);
    const enabled = (await enableRes.json()) as { enabled: boolean };
    expect(enabled.enabled).toBe(true);

    // hook 入口未装配 → 404 "hooks disabled"
    const hookRes = await fetch(`http://127.0.0.1:${port}/hooks/anything`, {
      method: "POST",
    });
    expect(hookRes.status).toBe(404);
  });

  it("跨用户访问 trigger / workflow / loop → 404（防越权 + 防存在性泄露）", async () => {
    const { port, token, token2 } = await startWorkflowChannel();
    const authA = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const authB = { Authorization: `Bearer ${token2}`, "Content-Type": "application/json" };

    // 用户 A 建一个 trigger
    const trig = await fetch(`http://127.0.0.1:${port}/api/triggers`, {
      method: "POST",
      headers: authA,
      body: JSON.stringify({
        name: "T-priv",
        type: "scheduler",
        scheduler: {
          cron: "0 9 * * *",
          source: { type: "http", url: "https://example.com", method: "GET" },
          matcher: { kind: "always" },
        },
      }),
    });
    const trigJson = (await trig.json()) as { id: string };

    // 用户 B 用同样 body 但 ownerId 会被服务端覆盖；尝试读、改、删 A 的 trigger
    const cases = [
      ["GET", `/api/triggers/${trigJson.id}`, null],
      ["PUT", `/api/triggers/${trigJson.id}`, { name: "hijack" }],
      ["DELETE", `/api/triggers/${trigJson.id}`, null],
      ["POST", `/api/triggers/${trigJson.id}/test`, null],
    ] as const;
    for (const [method, path, body] of cases) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: authB,
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(res.status).toBe(404);
    }

    // 用户 A 建 workflow + loop，B 跨用户访问也应 404
    const wf = await fetch(`http://127.0.0.1:${port}/api/workflows`, {
      method: "POST",
      headers: authA,
      body: JSON.stringify({ name: "W-priv", triggerId: trigJson.id, agentId: "a1" }),
    });
    const wfJson = (await wf.json()) as { id: string };
    const loop = await fetch(`http://127.0.0.1:${port}/api/loops`, {
      method: "POST",
      headers: authA,
      body: JSON.stringify({ name: "L-priv", workflowId: wfJson.id }),
    });
    const loopJson = (await loop.json()) as { id: string };

    for (const [method, path, body] of [
      ["GET", `/api/workflows/${wfJson.id}`, null],
      ["PUT", `/api/workflows/${wfJson.id}`, { name: "hijack" }],
      ["DELETE", `/api/workflows/${wfJson.id}`, null],
      ["GET", `/api/loops/${loopJson.id}`, null],
      ["PUT", `/api/loops/${loopJson.id}`, { name: "hijack" }],
      ["DELETE", `/api/loops/${loopJson.id}`, null],
    ] as const) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: authB,
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(res.status).toBe(404);
    }
  });

  it("/api/loops/:id/run 在 workflow 无 trigger 时返回 400（非 500）", async () => {
    const { port, token } = await startWorkflowChannel();
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    // 建 workflow 故意不绑 trigger，再建 loop 引用它
    // 注意：workflow create 不强制要求 triggerId 非空（zod schema 仅 .string()）
    const wf = await fetch(`http://127.0.0.1:${port}/api/workflows`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "no-trig", triggerId: "", agentId: "a1" }),
    });
    // triggerId 为空字符串，schema 应拒绝；如果 schema 接受，则走 /run 校验路径
    if (wf.status === 201) {
      const wfJson = (await wf.json()) as { id: string; triggerId: string };
      const loop = await fetch(`http://127.0.0.1:${port}/api/loops`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "L", workflowId: wfJson.id }),
      });
      const loopJson = (await loop.json()) as { id: string };
      const run = await fetch(`http://127.0.0.1:${port}/api/loops/${loopJson.id}/run`, {
        method: "POST",
        headers: auth,
      });
      expect(run.status).toBe(400);
      const body = (await run.json()) as { error: string };
      expect(body.error).toMatch(/trigger/);
    }
  });

  it("/api/loops/:id/runs 列出历史 run", async () => {
    const { port, token } = await startWorkflowChannel();
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    // loop 引用校验（2026-09-24 审计收口）：workflowId 必须指向本人 workflow——
    // 先建真实 trigger + workflow，再建 loop，查 runs 应为空数组
    const trigger = await fetch(`http://127.0.0.1:${port}/api/triggers`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "T",
        type: "hook",
        hook: {
          path: "/hooks/runs-test",
          responseStatus: 200,
          responseBody: "",
          matcher: { kind: "always" },
        },
      }),
    });
    const triggerJson = (await trigger.json()) as { id: string };
    const wf = await fetch(`http://127.0.0.1:${port}/api/workflows`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "W", triggerId: triggerJson.id, agentId: "a1" }),
    });
    const wfJson = (await wf.json()) as { id: string };
    const loop = await fetch(`http://127.0.0.1:${port}/api/loops`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "L", workflowId: wfJson.id }),
    });
    const loopJson = (await loop.json()) as { id: string };
    const runs = await fetch(`http://127.0.0.1:${port}/api/loops/${loopJson.id}/runs`, {
      headers: auth,
    });
    expect(runs.status).toBe(200);
    const body = (await runs.json()) as { runs: unknown[] };
    expect(body.runs).toEqual([]);
  });

  it("POST /api/triggers 畸形 JSON body → 400 (I4: SyntaxError → 400)", async () => {
    const { port, token } = await startWorkflowChannel();
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const res = await fetch(`http://127.0.0.1:${port}/api/triggers`, {
      method: "POST",
      headers: auth,
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/triggers 缺必填字段 → 400 (ZodError → 400)", async () => {
    const { port, token } = await startWorkflowChannel();
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    // 合法 JSON 但缺 name/type/scheduler
    const res = await fetch(`http://127.0.0.1:${port}/api/triggers`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ unrelated: "field" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/conversations/:id（会话权限模式）", () => {
  it("属主可切换 permissionMode；列表 DTO 附 effectivePermissionMode", async () => {
    const { port, token, userId, convStore } = await startWebWithAgents();
    const conv = await convStore.create(userId, "web", "模式测试");

    const res = await fetch(`http://127.0.0.1:${port}/api/conversations/${conv.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ permissionMode: "full_access" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { permissionMode: string }).permissionMode).toBe("full_access");
    expect((await convStore.get(conv.id))?.permissionMode).toBe("full_access");

    // 会话未绑定 agent：effective = 会话覆盖
    const list = await fetch(`http://127.0.0.1:${port}/api/conversations?userId=${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const items = (await list.json()) as Array<{
      id: string;
      effectivePermissionMode?: string;
    }>;
    const mine = items.find((c) => c.id === conv.id);
    expect(mine?.effectivePermissionMode).toBe("full_access");
  });

  it("PATCH 成功即通知 onPermissionModeChange（orchestrator registry 即时生效入口）", async () => {
    const seen: Array<{ conversationId: string; mode: AgentPermissionMode }> = [];
    const { port, token, userId, convStore } = await startWebWithAgents({
      onPermissionModeChange: (conversationId, mode) => seen.push({ conversationId, mode }),
    });
    const conv = await convStore.create(userId, "web", "回调测试");

    await fetch(`http://127.0.0.1:${port}/api/conversations/${conv.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ permissionMode: "full_access" }),
    });
    expect(seen).toEqual([{ conversationId: conv.id, mode: "full_access" }]);
  });

  it("非法模式值 → 400；不存在会话 → 404", async () => {
    const { port, token, userId, convStore } = await startWebWithAgents();
    const conv = await convStore.create(userId, "web", "模式测试");

    const bad = await fetch(`http://127.0.0.1:${port}/api/conversations/${conv.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ permissionMode: "yolo" }),
    });
    expect(bad.status).toBe(400);

    const missing = await fetch(
      `http://127.0.0.1:${port}/api/conversations/00000000-0000-0000-0000-000000000000`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ permissionMode: "full_access" }),
      },
    );
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 智能体回调链接（specs/2026-09-15-agent-callback-design.md）
// ---------------------------------------------------------------------------

describe("WebChannel agent callback", () => {
  interface CallbackFixture {
    port: number;
    token: string;
    userId: string;
    agentStore: SqliteAgentStore;
    callbackStore: SqliteAgentCallbackStore;
    convStore: SqliteConversationStore;
    messageStore: SqliteMessageStore;
    db: Database.Database;
  }

  async function startCallbackFixture(
    opts: { rateLimitPerMin?: number; busy?: boolean } = {},
  ): Promise<CallbackFixture> {
    const tmp = mkdtempSync(join(tmpdir(), "web-cb-"));
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
    const callbackStore = new SqliteAgentCallbackStore(db);
    callbackStore.migrate();
    const messageStore = new SqliteMessageStore(db);
    messageStore.migrate();
    const sessionStore = new JwtSessionStore(db, "test-secret", 3_600_000);
    sessionStore.migrate();
    const user = await userStore.getOrCreateByIdentity("internal", "webu", "tester");
    const { token } = await sessionStore.create(user.id);
    web = new WebChannel({
      port: 0,
      host: "127.0.0.1",
      workspaceDir: tmp,
      userStore,
      conversationStore: convStore,
      messageStore,
      sessionStore,
      agentStore,
      agentCallbackStore: callbackStore,
      callbackRateLimitPerMin: opts.rateLimitPerMin,
      conversationBusyGetter: () => opts.busy ?? false,
      // 模拟 orchestrator 轮完成：延迟落一条 bot 回复（真实实现在 index.ts 装配处）
      callbackSubmit: async (msg) => {
        await new Promise((r) => setTimeout(r, 500));
        await messageStore.add(msg.conversationId ?? msg.threadId, "bot", "done-reply");
      },
      agentMeta: { presets: [], skillPaths: [] },
    });
    web.onMessage(() => {});
    await web.ready();
    const port = web.boundPort;
    if (!port) throw new Error("server not listening");
    return { port, token, userId: user.id, agentStore, callbackStore, convStore, messageStore, db };
  }

  async function mkAgent(f: CallbackFixture, name: string) {
    return f.agentStore.create({
      ownerId: f.userId,
      name,
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
    });
  }

  it("管理端未登录 POST → 401", async () => {
    const f = await startCallbackFixture();
    const a = await mkAgent(f, "CB");
    const r = await fetch(`http://127.0.0.1:${f.port}/api/agents/${a.id}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(401);
  });

  it("POST 生成返回完整 url；GET 只显 token 尾 4 位（不泄完整 token）", async () => {
    const f = await startCallbackFixture();
    const a = await mkAgent(f, "CB");
    const create = await fetch(`http://127.0.0.1:${f.port}/api/agents/${a.id}/callback`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
      body: JSON.stringify({ validityDays: 30 }),
    });
    expect(create.status).toBe(200);
    const created = (await create.json()) as { token: string; url: string; expiresAt: string };
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(created.url).toContain(`/api/callbacks/${created.token}`);
    expect(created.expiresAt).toBeTruthy();

    const info = await fetch(`http://127.0.0.1:${f.port}/api/agents/${a.id}/callback`, {
      headers: { authorization: `Bearer ${f.token}` },
    });
    const dto = (await info.json()) as { configured: boolean; tokenTail: string };
    expect(dto.configured).toBe(true);
    expect(dto.tokenTail).toBe(created.token.slice(-4));
    expect(JSON.stringify(dto)).not.toContain(created.token.slice(0, 10));
  });

  it("POST 非法 validityDays → 400", async () => {
    const f = await startCallbackFixture();
    const a = await mkAgent(f, "CB");
    const r = await fetch(`http://127.0.0.1:${f.port}/api/agents/${a.id}/callback`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
      body: JSON.stringify({ validityDays: 7 }),
    });
    expect(r.status).toBe(400);
  });

  it("回调发起：202 + full_access 会话 + 用户消息落库", async () => {
    const f = await startCallbackFixture();
    const a = await mkAgent(f, "CB");
    const cb = await f.callbackStore.upsert(a.id, f.userId);
    const r = await fetch(
      `http://127.0.0.1:${f.port}/api/callbacks/${cb.token}?query=${encodeURIComponent("检查服务状态")}`,
    );
    expect(r.status).toBe(202);
    const body = (await r.json()) as { ok: boolean; conversationId: string; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("queued");
    const conv = await f.convStore.get(body.conversationId);
    expect(conv?.channelId).toBe("callback");
    expect(conv?.agentId).toBe(a.id);
    expect(conv?.permissionMode).toBe("full_access");
    expect(conv?.userId).toBe(f.userId);
    expect(conv?.title.startsWith("[回调]")).toBe(true);
    const msgs = await f.messageStore.listByConversation(body.conversationId);
    expect(msgs.map((m) => m.role)).toEqual(["user"]);
    // 回调 query 按不可信内容包装落库（规格 §5.1）
    expect(msgs[0]?.text).toContain('source="callback"');
    expect(msgs[0]?.text).toContain("检查服务状态");
  });

  it("无效 token → 401；缺 query → 400", async () => {
    const f = await startCallbackFixture();
    const bad = await fetch(`http://127.0.0.1:${f.port}/api/callbacks/no-such-token?query=x`);
    expect(bad.status).toBe(401);
    const a = await mkAgent(f, "CB");
    const cb = await f.callbackStore.upsert(a.id, f.userId);
    const noQuery = await fetch(`http://127.0.0.1:${f.port}/api/callbacks/${cb.token}`);
    expect(noQuery.status).toBe(400);
  });

  it("过期 token 发起 → 410；结果查询仍放行", async () => {
    const f = await startCallbackFixture();
    const a = await mkAgent(f, "CB");
    const cb = await f.callbackStore.upsert(a.id, f.userId);
    f.db
      .prepare("UPDATE agent_callbacks SET expiresAt = ? WHERE token = ?")
      .run(new Date(Date.now() - 1000).toISOString(), cb.token);
    const r = await fetch(`http://127.0.0.1:${f.port}/api/callbacks/${cb.token}?query=x`);
    expect(r.status).toBe(410);

    // 过期前已发起的会话：结果查询仍可取回
    const conv = await f.convStore.createWithAgent(f.userId, "callback", "[回调] t", a.id);
    await f.messageStore.add(conv.id, "user", "q");
    const res = await fetch(
      `http://127.0.0.1:${f.port}/api/callbacks/${cb.token}/conversations/${conv.id}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("queued");
  });

  it("结果查询：有 bot 回复 → completed；无 → queued；跨 agent 会话 → 404", async () => {
    const f = await startCallbackFixture();
    const a = await mkAgent(f, "CB");
    const other = await mkAgent(f, "OTHER");
    const cb = await f.callbackStore.upsert(a.id, f.userId);
    const conv = await f.convStore.createWithAgent(f.userId, "callback", "[回调] t", a.id);
    await f.messageStore.add(conv.id, "user", "q");
    const url = `http://127.0.0.1:${f.port}/api/callbacks/${cb.token}/conversations/${conv.id}`;

    const queued = await fetch(url);
    expect(((await queued.json()) as { status: string }).status).toBe("queued");

    await f.messageStore.add(conv.id, "bot", "reply-text");
    const done = await fetch(url);
    const doneBody = (await done.json()) as {
      status: string;
      messages: Array<{ role: string; text: string }>;
    };
    expect(doneBody.status).toBe("completed");
    expect(doneBody.messages.map((m) => m.role)).toEqual(["user", "bot"]);
    expect(doneBody.messages[1]?.text).toBe("reply-text");

    const foreign = await f.convStore.createWithAgent(f.userId, "callback", "t", other.id);
    const r404 = await fetch(
      `http://127.0.0.1:${f.port}/api/callbacks/${cb.token}/conversations/${foreign.id}`,
    );
    expect(r404.status).toBe(404);
  });

  it("busy 会话 status=running；限流按 token 生效", async () => {
    const f = await startCallbackFixture({ busy: true, rateLimitPerMin: 2 });
    const a = await mkAgent(f, "CB");
    const cb = await f.callbackStore.upsert(a.id, f.userId);
    const conv = await f.convStore.createWithAgent(f.userId, "callback", "[回调] t", a.id);
    const res = await fetch(
      `http://127.0.0.1:${f.port}/api/callbacks/${cb.token}/conversations/${conv.id}`,
    );
    expect(((await res.json()) as { status: string }).status).toBe("running");

    const first = await fetch(`http://127.0.0.1:${f.port}/api/callbacks/${cb.token}?query=1`);
    expect(first.status).toBe(202);
    const second = await fetch(`http://127.0.0.1:${f.port}/api/callbacks/${cb.token}?query=2`);
    expect(second.status).toBe(202);
    const third = await fetch(`http://127.0.0.1:${f.port}/api/callbacks/${cb.token}?query=3`);
    expect(third.status).toBe(429);
  });

  it("agent 删除级联吊销回调（DELETE /api/agents/:id 后 token 失效）", async () => {
    const f = await startCallbackFixture();
    const a = await mkAgent(f, "CB");
    const cb = await f.callbackStore.upsert(a.id, f.userId);
    const del = await fetch(`http://127.0.0.1:${f.port}/api/agents/${a.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(del.status).toBe(204);
    expect(await f.callbackStore.findByToken(cb.token)).toBeUndefined();
    const r = await fetch(`http://127.0.0.1:${f.port}/api/callbacks/${cb.token}?query=x`);
    expect(r.status).toBe(401);
  });
});

describe("WebChannel 审批门不设超时", () => {
  function makeChannel(): WebChannel {
    return new WebChannel({ port: 0, workspaceDir: makeWebRoot() });
  }

  it("requestApproval 永不超时（200ms 后仍挂起）", async () => {
    const web = makeChannel();
    let settled = false;
    const p = web.requestApproval("conv-1", { gateId: "deploy", title: "部署", summary: "s" });
    void p.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(settled).toBe(false);
  });

  it("停止任务经 cancelPendingApprovals 解开挂起并以「任务已中断」deny", async () => {
    const web = makeChannel();
    const p = web.requestApproval("conv-1", { gateId: "deploy", title: "部署", summary: "s" });
    web.cancelPendingApprovals("conv-1");
    await expect(p).resolves.toMatchObject({ approved: false, reason: "任务已中断" });
  });

  it("cancelPendingApprovals 只解开目标会话的挂起", async () => {
    const web = makeChannel();
    // 挂起表按 gateId 键控（同 gateId 并发挂起会互相覆盖——既有约束，同会话串行下不触发），
    // 跨会话隔离验证用不同 gateId
    const p1 = web.requestApproval("conv-1", { gateId: "deploy", title: "d1", summary: "s" });
    const p2 = web.requestApproval("conv-2", { gateId: "authoring", title: "d2", summary: "s" });
    web.cancelPendingApprovals("conv-1");
    await expect(p1).resolves.toMatchObject({ approved: false });
    let settled = false;
    void p2.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
  });
});

describe("WebChannel mention-candidates 会话引用候选", () => {
  async function setup() {
    const h = await startWebWithAgents();
    const agent = await h.agentStore.create({
      ownerId: h.userId,
      name: "CA",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      gitRepositories: [],
      extensionDirectories: [],
      gitAllowShellGit: false,
      defaultPermissionMode: "ask_before_change",
    });
    return { ...h, agent };
  }

  const get = (port: number, token: string, agentId: string, conversationId?: string) =>
    fetch(
      `http://127.0.0.1:${port}/api/agents/${agentId}/mention-candidates${conversationId ? `?conversationId=${conversationId}` : ""}`,
      { headers: { authorization: `Bearer ${token}` } },
    );

  it("开关未开启（缺省）：conversationRefEnabled=false 且会话候选恒空", async () => {
    const { port, token, agent, convStore, userId } = await setup();
    await convStore.createWithAgent(userId, "web", "旧会话", agent.id);
    const r = await get(port, token, agent.id);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      conversationRefEnabled: boolean;
      conversations: unknown[];
    };
    expect(body.conversationRefEnabled).toBe(false);
    expect(body.conversations).toEqual([]);
  });

  it("开启后返回本人按时间降序的会话候选，排除当前会话", async () => {
    const { port, token, agent, convStore, userId, agentStore } = await setup();
    await agentStore.update(agent.id, {
      ...agent,
      conversationScope: { enabled: true, agentIds: [], limit: 10 },
    });
    await convStore.createWithAgent(userId, "web", "绑定 agent 的会话", agent.id);
    const cur = await convStore.createWithAgent(userId, "web", "当前会话", agent.id);
    const r = await get(port, token, agent.id, cur.id);
    const body = (await r.json()) as {
      conversationRefEnabled: boolean;
      conversations: Array<{ title: string }>;
    };
    expect(body.conversationRefEnabled).toBe(true);
    expect(body.conversations.map((c) => c.title)).toEqual(["绑定 agent 的会话"]);
  });

  it("他人的会话即使绑定范围内智能体也不出现（IDOR）", async () => {
    const { port, token, agent, convStore, userStore, userId, agentStore } = await setup();
    await agentStore.update(agent.id, {
      ...agent,
      conversationScope: { enabled: true, agentIds: [] },
    });
    const other = await userStore.getOrCreateByIdentity("internal", "other", "other");
    await convStore.createWithAgent(userId, "web", "我的会话", agent.id);
    await convStore.createWithAgent(other.id, "web", "别人的会话", agent.id);
    const r = await get(port, token, agent.id);
    const body = (await r.json()) as { conversations: Array<{ title: string }> };
    expect(body.conversations.map((c) => c.title)).toEqual(["我的会话"]);
  });
});

describe("WebChannel /api/agents 扩展目录相对路径校验", () => {
  const post = (port: number, token: string, extensionDirectories: unknown) =>
    fetch(`http://127.0.0.1:${port}/api/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "A",
        skills: [],
        tools: { mode: "all", whitelist: [] },
        mcpServers: [],
        extensionDirectories,
      }),
    });

  it.each([
    ["POSIX 绝对", "/etc/data"],
    ["盘符", "D:\\code\\donger"],
    [".. 上跳", "docs/../secret"],
  ])("POST %s → 400", async (_label, path) => {
    const { port, token } = await startWebWithAgents();
    const r = await post(port, token, [{ id: "d1", name: "docs", path, access: "readWrite" }]);
    expect(r.status).toBe(400);
  });

  it("POST 相对路径 → 201 且反斜杠归一为 /", async () => {
    const { port, token } = await startWebWithAgents();
    const r = await post(port, token, [
      { id: "d1", name: "docs", path: "knowledge_base\\docs", access: "readOnly" },
    ]);
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      extensionDirectories: Array<{ path: string }>;
    };
    expect(body.extensionDirectories[0]?.path).toBe("knowledge_base/docs");
  });

  it("PATCH 绝对路径 → 400；PATCH 相对路径 → 200；存量绝对行 GET 不受影响", async () => {
    const { port, token, agentStore, userId } = await startWebWithAgents();
    // 直入 store 的存量行（含绝对路径条目）：读容忍
    const legacy = await agentStore.create({
      ownerId: userId,
      name: "legacy",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      extensionDirectories: [{ id: "d1", name: "旧目录", path: "D:\\legacy", access: "readWrite" }],
    });
    const getRes = await fetch(`http://127.0.0.1:${port}/api/agents/${legacy.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.status).toBe(200);

    const patch = (extensionDirectories: unknown) =>
      fetch(`http://127.0.0.1:${port}/api/agents/${legacy.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ extensionDirectories }),
      });
    expect(
      (await patch([{ id: "d1", name: "旧目录", path: "D:\\legacy", access: "readWrite" }])).status,
    ).toBe(400);
    const okRes = await patch([
      { id: "d1", name: "旧目录", path: "knowledge_base/docs", access: "readWrite" },
    ]);
    expect(okRes.status).toBe(200);
  });

  it("duplicate 剥离存量绝对路径条目并给出 warning", async () => {
    const { port, token, agentStore, userStore, userId, agentShareStore } =
      await startWebWithAgents();
    const other = await userStore.getOrCreateByIdentity("internal", "other", "other");
    const src = await agentStore.create({
      ownerId: other.id,
      name: "shared",
      skills: [],
      tools: { mode: "all", whitelist: [] },
      mcpServers: [],
      extensionDirectories: [
        { id: "d1", name: "相对", path: "knowledge_base/docs", access: "readWrite" },
        { id: "d2", name: "绝对", path: "D:\\legacy", access: "readWrite" },
      ],
    });
    // 被分享者复制：先建分享授权
    await agentShareStore.enableShare(src.id);
    await agentShareStore.addGrant(src.id, userId);
    const r = await fetch(`http://127.0.0.1:${port}/api/agents/${src.id}/duplicate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      extensionDirectories: Array<{ path: string }>;
      warnings: string[];
    };
    expect(body.extensionDirectories.map((d) => d.path)).toEqual(["knowledge_base/docs"]);
    expect(body.warnings.some((w) => w.includes("绝对路径"))).toBe(true);
  });
});
