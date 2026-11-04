import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteSessionRuntimeStore } from "../../src/adapters/sqlite-session-runtime-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { DevServerService } from "../../src/orchestrator/dev-server-service.js";

/**
 * /preview/:convId/* 会话预览反代契约（spec 2026-11-04-webgame-dev-loop-design §3.3）：
 * 鉴权（token 首访签发 cookie→子资源 cookie 续行）、属主口径、上游透传（含子路径与查询串）、
 * 未启动引导文案。上游为真实 node http 服务（仓库先例：真子进程测试）。
 */

const UPSTREAM_CMD =
  'node -e "require(\'http\').createServer((q,s)=>{s.setHeader(\'content-type\',\'text/plain\');s.end(\'up:\'+q.url)}).listen({port}, \'127.0.0.1\')"';

let web: WebChannel;
let db: Database.Database;
let usersDir: string;
let tmpDir: string;
let userStore: SqliteUserStore;
let sessionStore: JwtSessionStore;
let conversations: SqliteConversationStore;
let devServer: DevServerService;
const realFetch = globalThis.fetch;

beforeEach(() => {
  usersDir = mkdtempSync(join(tmpdir(), "pv-users-"));
  tmpDir = mkdtempSync(join(tmpdir(), "pv-ws-"));
});

afterEach(async () => {
  await devServer?.dispose().catch(() => undefined);
  void web?.stop();
  db?.close();
  rmSync(usersDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
});

async function startChannel(): Promise<number> {
  db = new Database(":memory:");
  sessionStore = new JwtSessionStore(db, "preview-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
  userStore.migrate();
  userStore.migrateCredentials();
  conversations = new SqliteConversationStore(db);
  conversations.migrate();
  const runtimeStore = new SqliteSessionRuntimeStore(db);
  runtimeStore.migrate();
  devServer = new DevServerService({ store: runtimeStore, readyTimeoutMs: 15_000, log: () => undefined });
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    conversationStore: conversations,
    devServerService: devServer,
  });
  web.onMessage(() => {});
  await web.ready();
  if (!web.boundPort) throw new Error("server not listening");
  return web.boundPort;
}

async function makeUser(name: string, role?: "admin"): Promise<{ id: string; token: string }> {
  const user = await userStore.getOrCreateByIdentity("test", name, name);
  if (role === "admin" && user.role !== "admin") await userStore.updateRole(user.id, "admin");
  const { token } = await sessionStore.create(user.id);
  return { id: user.id, token };
}

function req(
  port: number,
  path: string,
  token?: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
  });
}

describe("/preview 反代", () => {
  it("未带凭证 401；未启动 404 引导文案", async () => {
    const port = await startChannel();
    const owner = await makeUser("owner");
    const conv = await conversations.create(owner.id, "web", "t");
    expect((await req(port, `/preview/${conv.id}/`)).status).toBe(401);
    const resp = await req(port, `/preview/${conv.id}/`, owner.token);
    expect(resp.status).toBe(404);
    expect(await resp.text()).toContain("dev_start");
  });

  it("属主首访 200 + 签发预览 cookie；子路径/查询串透传上游", async () => {
    const port = await startChannel();
    const owner = await makeUser("owner");
    const conv = await conversations.create(owner.id, "web", "t");
    await devServer.start({
      conversationId: conv.id,
      ownerId: owner.id,
      agentId: null,
      cwd: tmpDir,
      cmd: UPSTREAM_CMD,
    });
    const resp = await req(port, `/preview/${conv.id}/index.html?a=1`, owner.token);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("up:/index.html?a=1");
    const setCookie = resp.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("donger_preview=");
    // 子资源不带 token，凭 cookie 续行
    const token = /donger_preview=([\da-f]+)/.exec(setCookie)?.[1] ?? "";
    const sub = await req(port, `/preview/${conv.id}/assets/x.js`, undefined, {
      cookie: `donger_preview=${token}`,
    });
    expect(sub.status).toBe(200);
    expect(await sub.text()).toBe("up:/assets/x.js");
  });

  it("非属主 403；admin 放行", async () => {
    const port = await startChannel();
    const owner = await makeUser("owner");
    const admin = await makeUser("root", "admin");
    const stranger = await makeUser("stranger");
    const conv = await conversations.create(owner.id, "web", "t");
    await devServer.start({
      conversationId: conv.id,
      ownerId: owner.id,
      agentId: null,
      cwd: tmpDir,
      cmd: UPSTREAM_CMD,
    });
    expect((await req(port, `/preview/${conv.id}/`, stranger.token)).status).toBe(403);
    const adminResp = await req(port, `/preview/${conv.id}/`, admin.token);
    expect(adminResp.status).toBe(200);
    expect(await adminResp.text()).toBe("up:/");
  });

  it("未知会话 404；畸形 id 400", async () => {
    const port = await startChannel();
    const owner = await makeUser("owner");
    expect((await req(port, `/preview/conv-ghost/`, owner.token)).status).toBe(404);
    expect((await req(port, `/preview/..%2Fetc/`, owner.token)).status).toBe(400);
  });
});
