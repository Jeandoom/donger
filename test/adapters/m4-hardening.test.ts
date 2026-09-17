import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteInviteStore } from "../../src/adapters/sqlite-invite-store.js";
import { SqliteTriggerStore } from "../../src/adapters/sqlite-trigger-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";

/**
 * M4 收尾契约：一次性登录 code、hooks path 随机化、uploads 鉴权。
 */

let web: WebChannel;
let db: Database.Database;
let usersDir: string;
let tmpDir: string;
let userStore: SqliteUserStore;
let sessionStore: JwtSessionStore;
const realFetch = globalThis.fetch;

async function startChannel(): Promise<number> {
  db = new Database(":memory:");
  sessionStore = new JwtSessionStore(db, "m4-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
  userStore.migrate();
  userStore.migrateCredentials();
  const convs = new SqliteConversationStore(db);
  convs.migrate();
  const inviteStore = new SqliteInviteStore(db);
  inviteStore.migrate();
  const triggers = new SqliteTriggerStore(db);
  triggers.migrate();
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    conversationStore: convs,
    inviteStore,
    triggerStore: triggers,
    emailSignupAllowedDomains: new Set(["example.com"]),
  });
  web.onMessage(() => {});
  await web.ready();
  if (!web.boundPort) throw new Error("server not listening");
  return web.boundPort;
}

function post(port: number, path: string, body: unknown, token?: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(port: number, path: string, token?: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: "manual",
  });
}

/** 注册 → 管理端拿验证链接 → 核销（302 code=）→ code 换 token */
async function registerAndVerify(
  port: number,
  email: string,
): Promise<{ token: string; code: string }> {
  await post(port, "/api/auth/register", { email, password: "abcd1234" });
  const admin = await userStore.getOrCreateByIdentity("test", "root", "Root");
  await userStore.updateRole(admin.id, "admin");
  const { token: adminJwt } = await sessionStore.create(admin.id);
  const list = await get(port, "/api/admin/email-verifications", adminJwt);
  const { verifications } = (await list.json()) as {
    verifications: Array<{ email?: string; verifyPath: string | null }>;
  };
  const pending = verifications.find((v) => v.email === email);
  if (!pending?.verifyPath) throw new Error("no verify path");
  const verifyRes = await get(port, pending.verifyPath);
  const location = verifyRes.headers.get("location") ?? "";
  const code = new URLSearchParams(location.split("?")[1] ?? "").get("code");
  if (!code) throw new Error(`no code in location: ${location}`);
  const ex = await post(port, "/api/auth/code-exchange", { code });
  const { token } = (await ex.json()) as { token: string };
  return { token, code };
}

beforeEach(() => {
  usersDir = mkdtempSync(join(tmpdir(), "m4-users-"));
  tmpDir = mkdtempSync(join(tmpdir(), "m4-ws-"));
});
afterEach(() => {
  void web?.stop();
  db?.close();
  rmSync(usersDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("一次性登录 code（规格 M4：token 不进 URL）", () => {
  it("verify 回调 302 带 code；exchange 换 token 可用；code 单次有效", async () => {
    const port = await startChannel();
    const { token, code } = await registerAndVerify(port, "one@example.com");
    expect(token).toBeTruthy();
    // 换到的 token 真实可用
    const me = await get(port, "/api/auth/me", token);
    expect(me.status).toBe(200);
    // 同 code 二次交换 → 401（一次性）
    const again = await post(port, "/api/auth/code-exchange", { code });
    expect(again.status).toBe(401);
    // 无效 code → 401
    expect((await post(port, "/api/auth/code-exchange", { code: "junk" })).status).toBe(401);
  });
});

describe("hooks path 随机化（规格 M4：未认证触发通道防扫描）", () => {
  it("hook 类型缺省 path → 服务端生成不可猜随机 slug；显式 path 保持", async () => {
    const port = await startChannel();
    const { token } = await registerAndVerify(port, "hooker@example.com");
    const created = await post(
      port,
      "/api/triggers",
      {
        name: "auto",
        type: "hook",
        hook: { matcher: { kind: "always" }, responseStatus: 200, responseBody: "ok" },
      },
      token,
    );
    expect(created.status).toBe(201);
    const auto = (await created.json()) as { path?: string; hook?: { path: string } };
    // 未认证触发匹配走 hook.path（hook-registry 按 $.hook.path 查询）
    expect(auto.hook?.path).toMatch(/^\/hooks\/[0-9a-f]{16}$/);
    if (typeof auto.path === "string") expect(auto.path).toMatch(/^\/hooks\/[0-9a-f]{16}$/);

    const explicit = await post(
      port,
      "/api/triggers",
      {
        name: "manual",
        type: "hook",
        path: "/hooks/my-legacy-webhook",
        hook: { matcher: { kind: "always" }, responseStatus: 200, responseBody: "ok" },
      },
      token,
    );
    expect(explicit.status).toBe(201);
    const manual = (await explicit.json()) as {
      path?: string;
      hook?: { path: string };
    };
    expect(manual.hook?.path).toBe("/hooks/my-legacy-webhook");
  });
});

describe("uploads 鉴权（规格 M4：附件不再无鉴权直出）", () => {
  it("无 token → 401；他人 token → 403；属主 token → 200", async () => {
    const port = await startChannel();
    const { token } = await registerAndVerify(port, "owner@example.com");
    const u = (await userStore.findByIdentity("email", "owner@example.com"))!;
    const other = await userStore.getOrCreateByIdentity("test", "intruder", "Intruder");
    const { token: otherToken } = await sessionStore.create(other.id);

    // 会话 id 来自 conversationStore——经 API 创建更直接
    const createRes = await post(port, "/api/conversations", { userId: u.id }, token);
    expect(createRes.status).toBe(201);
    const convId = ((await createRes.json()) as { id: string }).id;

    // 造附件文件：按 resolveAttachmentDir 布局 <home>/sessions/<conv>/workspace/attachments
    const attDir = join(u.homeDir, "sessions", convId, "workspace", "attachments");
    mkdirSync(attDir, { recursive: true });
    writeFileSync(join(attDir, "note.md"), "# hello");

    expect((await get(port, `/uploads/${convId}/note.md`)).status).toBe(401);
    expect((await get(port, `/uploads/${convId}/note.md`, otherToken)).status).toBe(403);
    const ok = await get(port, `/uploads/${convId}/note.md`, token);
    expect(ok.status).toBe(200);
  });
});
