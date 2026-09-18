import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { MemoryRateLimiter } from "../../src/adapters/memory-rate-limiter.js";
import { SqliteInviteStore } from "../../src/adapters/sqlite-invite-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { INVITE_MONTHLY_QUOTA, monthStartIso } from "../../src/domain/invite.js";

/**
 * 邮箱验证状态机 + 邀请月度配额契约测试（设计规格 §6，裁决①②⑤）。
 * 验证链接只在管理端可见（方案 B 线下转交）；24h 不验证即失效（裁决②）。
 */

let web: WebChannel;
let db: Database.Database;
let usersDir: string;
let tmpDir: string;
let userStore: SqliteUserStore;
let sessionStore: JwtSessionStore;
const realFetch = globalThis.fetch;

async function startChannel(domains: string[] = ["example.com"]): Promise<number> {
  db = new Database(":memory:");
  sessionStore = new JwtSessionStore(db, "verify-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
  userStore.migrate();
  userStore.migrateCredentials();
  const inviteStore = new SqliteInviteStore(db);
  inviteStore.migrate();
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    inviteStore,
    emailSignupAllowedDomains: new Set(domains),
  });
  web.onMessage(() => {});
  await web.ready();
  if (!web.boundPort) throw new Error("server not listening");
  return web.boundPort;
}

function post(port: number, path: string, body: unknown): Promise<Response> {
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(port: number, path: string, token?: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: "manual",
  });
}

async function adminToken(): Promise<string> {
  const admin = await userStore.getOrCreateByIdentity("test", "root", "Root");
  await userStore.updateRole(admin.id, "admin");
  const { token } = await sessionStore.create(admin.id);
  return token;
}

beforeEach(() => {
  usersDir = mkdtempSync(join(tmpdir(), "verify-users-"));
  tmpDir = mkdtempSync(join(tmpdir(), "verify-ws-"));
});
afterEach(() => {
  void web?.stop();
  db?.close();
  rmSync(usersDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
});

async function registerPending(port: number, email: string): Promise<void> {
  const res = await post(port, "/api/auth/register", { email, password: "abcd1234" });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { token?: string };
  expect(body.token).toBeUndefined();
}

describe("邮箱验证状态机", () => {
  it("注册 → pending；未验证登录 401；管理端可见验证链接；核销后可登录", async () => {
    const port = await startChannel();
    await registerPending(port, "alice@example.com");

    // 未验证登录：401 且不泄漏账号是否存在
    const denied = await post(port, "/api/auth/login", {
      email: "alice@example.com",
      password: "abcd1234",
    });
    expect(denied.status).toBe(401);
    const deniedBody = (await denied.json()) as { error: string };
    expect(deniedBody.error).toContain("尚未验证");

    // 管理端列表（方案 B 转交数据源）
    const list = await get(port, "/api/admin/email-verifications", await adminToken());
    expect(list.status).toBe(200);
    const { verifications } = (await list.json()) as {
      verifications: Array<{ email?: string; verified: boolean; verifyPath: string | null }>;
    };
    const pending = verifications.find((v) => v.email === "alice@example.com");
    expect(pending?.verified).toBe(false);
    expect(pending?.verifyPath).toContain("/api/auth/verify?token=");

    // 核销 → 302 带 token；登录 200
    const verify = await get(port, pending!.verifyPath!);
    expect(verify.status).toBe(302);
    expect(verify.headers.get("location")).toContain("/login/success?code=");
    const login = await post(port, "/api/auth/login", {
      email: "alice@example.com",
      password: "abcd1234",
    });
    expect(login.status).toBe(200);
  });

  it("无效 token 核销 → 302 错误；token 一次性（二次核销失败）", async () => {
    const port = await startChannel();
    await registerPending(port, "bob@example.com");
    const bad = await get(port, "/api/auth/verify?token=not-a-real-token");
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toContain("error=");

    const u = (await userStore.findByIdentity("email", "bob@example.com"))!;
    const v = (await userStore.getEmailVerification(u.id))!;
    expect(await userStore.markEmailVerified(v.token!)).toBe(u.id);
    // 二次核销：token 已清 → 失败
    expect(await userStore.markEmailVerified(v.token!)).toBeUndefined();
  });

  it("24h 过期（裁决②）：登录提示账号失效；复注册复活（新验证窗口）", async () => {
    const port = await startChannel();
    await registerPending(port, "carol@example.com");
    // 时间快进：把过期时间拨到过去
    db.prepare("UPDATE user_email_credentials SET verifyExpiresAt = ?").run(
      new Date(Date.now() - 1000).toISOString(),
    );
    const denied = await post(port, "/api/auth/login", {
      email: "carol@example.com",
      password: "abcd1234",
    });
    expect(denied.status).toBe(401);
    expect(((await denied.json()) as { error: string }).error).toContain("已失效");

    // 复注册（202 复活，新 token 新窗口）
    const revive = await post(port, "/api/auth/register", {
      email: "carol@example.com",
      password: "abcd1234",
    });
    expect(revive.status).toBe(202);

    // 核销新链接 → 登录 200
    const list = await get(port, "/api/admin/email-verifications", await adminToken());
    const { verifications } = (await list.json()) as {
      verifications: Array<{ email?: string; verifyPath: string | null }>;
    };
    const pending = verifications.find((v) => v.email === "carol@example.com");
    expect(pending?.verifyPath).toBeTruthy();
    await get(port, pending!.verifyPath!);
    expect(
      (await post(port, "/api/auth/login", { email: "carol@example.com", password: "abcd1234" }))
        .status,
    ).toBe(200);
  });

  it("未过期 + 已验证账号复注册 → 409（防枚举语义保留）", async () => {
    const port = await startChannel();
    await registerPending(port, "dave@example.com");
    // 未过期 pending：409
    expect(
      (await post(port, "/api/auth/register", { email: "dave@example.com", password: "abcd1234" }))
        .status,
    ).toBe(409);
    // 验证后：409
    const u = (await userStore.findByIdentity("email", "dave@example.com"))!;
    const v = (await userStore.getEmailVerification(u.id))!;
    await userStore.markEmailVerified(v.token!);
    expect(
      (await post(port, "/api/auth/register", { email: "dave@example.com", password: "abcd1234" }))
        .status,
    ).toBe(409);
  });

  it("admin 守卫：member 访问验证列表 → 403", async () => {
    const port = await startChannel();
    await registerPending(port, "eve@example.com");
    const u = (await userStore.findByIdentity("email", "eve@example.com"))!;
    const { token } = await sessionStore.create(u.id);
    const r = await get(port, "/api/admin/email-verifications", token);
    expect(r.status).toBe(403);
  });
});

describe("邀请月度配额（裁决⑤：每账号每自然月 30 个）", () => {
  it("达到月度上限后生成 → 429", async () => {
    const port = await startChannel();
    await registerPending(port, "owner@example.com");
    const u = (await userStore.findByIdentity("email", "owner@example.com"))!;
    const v = (await userStore.getEmailVerification(u.id))!;
    await userStore.markEmailVerified(v.token!);
    const { token } = await sessionStore.create(u.id);

    let last = 0;
    for (let i = 0; i <= INVITE_MONTHLY_QUOTA; i++) {
      last = (
        await realFetch(`http://127.0.0.1:${port}/api/invites`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: "{}",
        })
      ).status;
      if (i < INVITE_MONTHLY_QUOTA) expect(last).toBe(201);
    }
    expect(last).toBe(429);
  });

  it("monthStartIso 落在本月 1 日（跨月自动恢复窗口）", () => {
    const start = new Date(monthStartIso(new Date("2026-09-17T10:00:00Z")));
    expect(start.getMonth()).toBe(8); // September
    expect(start.getDate()).toBeLessThanOrEqual(1);
  });
});

describe("MemoryRateLimiter", () => {
  it("窗口内计数、超限拒绝、窗口滚动后恢复", async () => {
    const limiter = new MemoryRateLimiter();
    for (let i = 0; i < 5; i++) expect(limiter.hit("k", 50, 5)).toBe(true);
    expect(limiter.hit("k", 50, 5)).toBe(false);
    expect(limiter.count("k", 50)).toBe(6);
    await new Promise((r) => setTimeout(r, 60));
    expect(limiter.count("k", 50)).toBe(0);
    expect(limiter.hit("k", 50, 5)).toBe(true);
  });
});
