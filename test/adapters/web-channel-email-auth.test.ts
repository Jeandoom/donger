import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteInviteStore } from "../../src/adapters/sqlite-invite-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { buildInvite } from "../../src/domain/invite.js";
import { hashPassword } from "../../src/util/password.js";

/**
 * 邮箱注册/登录/邀请契约测试。
 * 限流为每 IP 每分钟 5 次（register+login 共用），测试统一走 127.0.0.1 桶，
 * 超过阈值的断言放在各 describe 末尾或用不同场景顺序规避。
 */

let web: WebChannel;
let db: Database.Database;
let usersDir: string;
let tmpDir: string;
let inviteStore: SqliteInviteStore;
let userStore: SqliteUserStore;
let sessionStore: JwtSessionStore;
let domains: Set<string>;

const realFetch = globalThis.fetch;

interface StartOpts {
  domains?: string[];
}

async function startChannel(opts: StartOpts = {}): Promise<number> {
  db = new Database(":memory:");
  sessionStore = new JwtSessionStore(db, "test-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
  userStore.migrate();
  userStore.migrateCredentials();
  inviteStore = new SqliteInviteStore(db);
  inviteStore.migrate();
  domains = new Set(opts.domains ?? []);
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    inviteStore,
    emailSignupAllowedDomains: domains,
  });
  web.onMessage(() => {});
  await web.ready();
  const port = web.boundPort;
  if (!port) throw new Error("server not listening");
  return port;
}

function post(port: number, path: string, body: unknown): Promise<Response> {
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 注册 + 直接核销验证（跳过方案 B 的线下转交环节），返回登录 token */
async function registerVerified(
  port: number,
  email: string,
  password: string,
  invite?: string,
): Promise<string> {
  const reg = await post(port, "/api/auth/register", { email, password, invite });
  // 202=新注册/复活；409=该账号已存在且未过期（已注册场景复用）
  expect([202, 409]).toContain(reg.status);
  const u = await userStore.findByIdentity("email", email);
  if (!u) throw new Error(`user missing: ${email}`);
  const v = await userStore.getEmailVerification(u.id);
  if (!v?.token) throw new Error("verify token missing");
  const marked = await userStore.markEmailVerified(v.token);
  if (!marked) throw new Error("verify mark failed");
  const login = await post(port, "/api/auth/login", { email, password });
  const body = (await login.json()) as { token?: string };
  if (!body.token) throw new Error(`login failed: ${JSON.stringify(body)}`);
  return body.token;
}

beforeEach(() => {
  usersDir = mkdtempSync(join(tmpdir(), "email-users-"));
  tmpDir = mkdtempSync(join(tmpdir(), "email-ws-"));
});
afterEach(() => {
  void web?.stop();
  db?.close();
  rmSync(usersDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/auth/register", () => {
  it("服务未装配 inviteStore → 503", async () => {
    db = new Database(":memory:");
    const ss = new JwtSessionStore(db, "test-secret");
    ss.migrate();
    const us = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
    us.migrate();
    us.migrateCredentials();
    web = new WebChannel({
      port: 0,
      host: "127.0.0.1",
      workspaceDir: tmpDir,
      sessionStore: ss,
      userStore: us,
    });
    web.onMessage(() => {});
    await web.ready();
    const port = web.boundPort ?? 0;
    const res = await post(port, "/api/auth/register", { email: "a@b.com", password: "abcd1234" });
    expect(res.status).toBe(503);
  });

  it("白名单命中 → 注册受理 202（pending 不发 token），验证后可登录", async () => {
    const port = await startChannel({ domains: ["example.com"] });
    const res = await post(port, "/api/auth/register", {
      email: "Alice@Example.com",
      password: "abcd1234",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok?: boolean; token?: string };
    expect(body.ok).toBe(true);
    expect(body.token).toBeUndefined();
    // 未验证登录被拒
    expect(
      (await post(port, "/api/auth/login", { email: "alice@example.com", password: "abcd1234" }))
        .status,
    ).toBe(401);
    // 管理员核销验证链接后可登录
    const u = await userStore.findByIdentity("email", "alice@example.com");
    if (!u) throw new Error("user missing");
    const v = await userStore.getEmailVerification(u.id);
    if (!v?.token) throw new Error("verify token missing");
    expect(await userStore.markEmailVerified(v.token)).toBe(u.id);
    const login = await post(port, "/api/auth/login", {
      email: "alice@example.com",
      password: "abcd1234",
    });
    expect(login.status).toBe(200);
    const { token } = (await login.json()) as { token: string };
    const me = await realFetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
  });

  it("非白名单域名且无邀请 → 403", async () => {
    const port = await startChannel({ domains: ["example.com"] });
    const res = await post(port, "/api/auth/register", {
      email: "a@robot.cn",
      password: "abcd1234",
    });
    expect(res.status).toBe(403);
  });

  it("白名单为空（未配置）→ 无邀请一律 403", async () => {
    const port = await startChannel();
    const res = await post(port, "/api/auth/register", {
      email: "a@example.com",
      password: "abcd1234",
    });
    expect(res.status).toBe(403);
  });

  it("有效邀请 → 任意域名可注册且不受白名单限制", async () => {
    const port = await startChannel();
    const invite = buildInvite({ createdBy: "u1", expiresInDays: 7, maxUses: 1 });
    await inviteStore.create(invite);
    const res = await post(port, "/api/auth/register", {
      email: "guest@anywhere.io",
      password: "abcd1234",
      invite: invite.token,
    });
    expect(res.status).toBe(202);
    // 单次邀请已用尽 → 二次注册同邀请被拒
    const again = await post(port, "/api/auth/register", {
      email: "second@anywhere.io",
      password: "abcd1234",
      invite: invite.token,
    });
    expect(again.status).toBe(403);
  });

  it("过期邀请 → 403", async () => {
    const port = await startChannel();
    const invite = buildInvite({ createdBy: "u1", expiresInDays: 7, maxUses: 5 });
    await inviteStore.create(invite);
    db.prepare("UPDATE user_invites SET expiresAt = ?").run(new Date(0).toISOString());
    const res = await post(port, "/api/auth/register", {
      email: "x@example.com",
      password: "abcd1234",
      invite: invite.token,
    });
    expect(res.status).toBe(403);
  });

  it("重复邮箱 → 409；弱密码 → 400", async () => {
    const port = await startChannel({ domains: ["example.com"] });
    expect(
      (await post(port, "/api/auth/register", { email: "a@example.com", password: "abc" })).status,
    ).toBe(400);
    expect(
      (await post(port, "/api/auth/register", { email: "a@example.com", password: "abcd1234" }))
        .status,
    ).toBe(202);
    expect(
      (await post(port, "/api/auth/register", { email: "a@example.com", password: "abcd1234" }))
        .status,
    ).toBe(409);
  });

  it("同分钟内超过 5 次 → 429（IP 限流）", async () => {
    const port = await startChannel({ domains: ["example.com"] });
    let last = 0;
    for (let i = 0; i < 7; i++) {
      last = (
        await post(port, "/api/auth/register", { email: `u${i}@example.com`, password: "abcd1234" })
      ).status;
    }
    expect(last).toBe(429);
  });
});

describe("POST /api/auth/login", () => {
  it("注册后可登录；错误密码/不存在邮箱统一 401", async () => {
    const port = await startChannel({ domains: ["example.com"] });
    await post(port, "/api/auth/register", { email: "a@example.com", password: "abcd1234" });
    // 注意：上面已消耗 1 次限流额度，同 IP 还有 4 次；registerVerified 复用该账号（409 容忍）
    const token = await registerVerified(port, "a@example.com", "abcd1234");
    expect(token).toBeTruthy();
    expect(
      (await post(port, "/api/auth/login", { email: "a@example.com", password: "wrong1234" }))
        .status,
    ).toBe(401);
    expect(
      (await post(port, "/api/auth/login", { email: "nobody@example.com", password: "abcd1234" }))
        .status,
    ).toBe(401);
  });
});

describe("邀请管理端点", () => {
  it("未登录 → 401", async () => {
    const port = await startChannel();
    expect((await realFetch(`http://127.0.0.1:${port}/api/invites`)).status).toBe(401);
  });

  it("生成 → 列表可见 → 禁用后注册被拒", async () => {
    const port = await startChannel({ domains: ["example.com"] });
    // 造一个已登录用户（直接走注册+白名单）
    const token = await registerVerified(port, "owner@example.com", "abcd1234");
    // 创建邀请（此刻起用新 IP 桶？同 IP 已用 1 次，继续可用）
    const createRes = await realFetch(`http://127.0.0.1:${port}/api/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ expiresInDays: 7, maxUses: 2 }),
    });
    expect(createRes.status).toBe(201);
    const { invite } = (await createRes.json()) as { invite: { id: string; token: string } };
    // 列表
    const listRes = await realFetch(`http://127.0.0.1:${port}/api/invites`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const list = (await listRes.json()) as { invites: { id: string }[] };
    expect(list.invites.map((i) => i.id)).toContain(invite.id);
    // 禁用后凭邀请注册失败
    expect(
      (
        await realFetch(`http://127.0.0.1:${port}/api/invites/${invite.id}/disable`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
    const denied = await post(port, "/api/auth/register", {
      email: "guest@any.io",
      password: "abcd1234",
      invite: invite.token,
    });
    expect(denied.status).toBe(403);
  });
});
