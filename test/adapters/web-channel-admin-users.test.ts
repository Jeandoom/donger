import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteSystemEventStore } from "../../src/adapters/sqlite-system-event-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";

/**
 * 用户管理 API 契约（spec 2026-09-21-user-management-design §2.1/§2.2）：
 * 越权必测项（member 403）、DTO 信息面收敛（无 homeDir）、防锁死守卫
 * （禁自改/白名单保护/禁降最后 admin）、角色变更即时生效链路、系统事件留痕。
 */

let web: WebChannel;
let db: Database.Database;
let usersDir: string;
let tmpDir: string;
let userStore: SqliteUserStore;
let systemEventStore: SqliteSystemEventStore;
let sessionStore: JwtSessionStore;
const realFetch = globalThis.fetch;

async function startChannel(whitelist: string[] = []): Promise<number> {
  db = new Database(":memory:");
  sessionStore = new JwtSessionStore(db, "admin-users-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, {
    adminExternalIds: new Set(whitelist),
    usersDir,
  });
  userStore.migrate();
  userStore.migrateCredentials();
  systemEventStore = new SqliteSystemEventStore(db);
  systemEventStore.migrate();
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    systemEventStore,
  });
  web.onMessage(() => {});
  await web.ready();
  if (!web.boundPort) throw new Error("server not listening");
  return web.boundPort;
}

async function makeUser(
  name: string,
  role?: "admin",
  provider = "test",
): Promise<{ id: string; token: string }> {
  const user = await userStore.getOrCreateByIdentity(provider, name, name);
  if (role === "admin" && user.role !== "admin") await userStore.updateRole(user.id, "admin");
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

beforeEach(() => {
  usersDir = mkdtempSync(join(tmpdir(), "au-users-"));
  tmpDir = mkdtempSync(join(tmpdir(), "au-ws-"));
});
afterEach(() => {
  void web?.stop();
  db?.close();
  rmSync(usersDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("用户管理：列表与越权", () => {
  it("member 访问列表/角色变更均 403（守卫 admin 规则）；未登录 401", async () => {
    const port = await startChannel();
    const member = await makeUser("alice");
    const res1 = await req(port, "GET", "/api/admin/users", member.token);
    expect(res1.status).toBe(403);
    const res2 = await req(port, "PATCH", `/api/admin/users/x/role`, member.token, {
      role: "admin",
    });
    expect(res2.status).toBe(403);
    const res3 = await req(port, "GET", "/api/admin/users");
    expect(res3.status).toBe(401);
  });

  it("admin 列表返回全量 DTO：无 homeDir、含 identities", async () => {
    const port = await startChannel();
    const admin = await makeUser("root", "admin");
    const bob = await makeUser("bob");
    const res = await req(port, "GET", "/api/admin/users", admin.token);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.homeDir).toBeUndefined();
      expect(Array.isArray(row.identities)).toBe(true);
    }
    const bobRow = rows.find((r) => r.id === bob.id);
    expect(bobRow?.role).toBe("user");
    const identities = bobRow?.identities as Array<{ provider: string; externalId: string }>;
    expect(identities[0]?.externalId).toBe("bob");
  });

  it("admin 授予/取消角色后目标用户下一请求即生效（/api/auth/me role 翻转）", async () => {
    const port = await startChannel();
    const admin = await makeUser("root", "admin");
    const bob = await makeUser("bob");

    const promote = await req(port, "PATCH", `/api/admin/users/${bob.id}/role`, admin.token, {
      role: "admin",
    });
    expect(promote.status).toBe(200);
    const promoted = ((await promote.json()) as { user: { role: string } }).user;
    expect(promoted.role).toBe("admin");
    const meRes = await req(port, "GET", "/api/auth/me", bob.token);
    expect(((await meRes.json()) as { user: { role: string } }).user.role).toBe("admin");

    const demote = await req(port, "PATCH", `/api/admin/users/${bob.id}/role`, admin.token, {
      role: "user",
    });
    expect(demote.status).toBe(200);
    const meRes2 = await req(port, "GET", "/api/auth/me", bob.token);
    expect(((await meRes2.json()) as { user: { role: string } }).user.role).toBe("user");

    const events = await systemEventStore.list();
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe("user_role_change");
    expect(events[0]?.detail).toContain("root");
  });

  it("非法 role 400；用户不存在 404", async () => {
    const port = await startChannel();
    const admin = await makeUser("root", "admin");
    const bad = await req(port, "PATCH", "/api/admin/users/whatever/role", admin.token, {
      role: "superadmin",
    });
    expect(bad.status).toBe(400);
    const missing = await req(
      port,
      "PATCH",
      `/api/admin/users/00000000-0000-0000-0000-000000000000/role`,
      admin.token,
      { role: "admin" },
    );
    expect(missing.status).toBe(404);
  });

  it("禁自改：admin 变更自己 409（用户 P0 对策）", async () => {
    const port = await startChannel();
    const admin = await makeUser("root", "admin");
    const res = await req(port, "PATCH", `/api/admin/users/${admin.id}/role`, admin.token, {
      role: "user",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("自己");
  });

  it("白名单保护：ADMIN_EXTERNAL_IDS 授予的 admin 不可页面取消，409 带提示（用户 P1 对策）", async () => {
    const port = await startChannel(["wx999"]);
    const whitelisted = await userStore.getOrCreateByIdentity("dingtalk", "wx999", "老王");
    expect(whitelisted.role).toBe("admin");
    const { token: adminToken } = await makeUser("root2", "admin");
    const res = await req(port, "PATCH", `/api/admin/users/${whitelisted.id}/role`, adminToken, {
      role: "user",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("ADMIN_EXTERNAL_IDS");
  });

  it("禁降最后一位 admin：唯一 admin 为目标（本地免认证 viewer）时 409", async () => {
    // 无 sessionStore 装配 → viewer={id:"local",role:"admin"}（非库内用户），
    // 目标为库里唯一 admin 时 hasAnyAdminExcluding=false → 命中最后 admin 守卫
    db = new Database(":memory:");
    userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
    userStore.migrate();
    userStore.migrateCredentials();
    const sole = await userStore.getOrCreateByIdentity("test", "sole");
    await userStore.updateRole(sole.id, "admin");
    systemEventStore = new SqliteSystemEventStore(db);
    systemEventStore.migrate();
    web = new WebChannel({
      port: 0,
      host: "127.0.0.1",
      workspaceDir: tmpDir,
      userStore,
      systemEventStore,
    });
    web.onMessage(() => {});
    await web.ready();
    const port = web.boundPort;
    if (!port) throw new Error("server not listening");

    const res = await req(port, "PATCH", `/api/admin/users/${sole.id}/role`, undefined, {
      role: "user",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("至少保留一位管理员");
  });

  it("GET /api/admin/system-events admin 可读、member 403", async () => {
    const port = await startChannel();
    const admin = await makeUser("root", "admin");
    const member = await makeUser("alice");
    await systemEventStore.record({
      type: "user_role_change",
      actorId: admin.id,
      actorName: "root",
      detail: "测试事件",
    });
    const ok = await req(port, "GET", "/api/admin/system-events", admin.token);
    expect(ok.status).toBe(200);
    const { events } = (await ok.json()) as { events: Array<{ detail: string }> };
    expect(events[0]?.detail).toBe("测试事件");
    const denied = await req(port, "GET", "/api/admin/system-events", member.token);
    expect(denied.status).toBe(403);
  });
});
