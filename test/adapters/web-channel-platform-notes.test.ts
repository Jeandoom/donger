import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteModuleConfigStore } from "../../src/adapters/sqlite-module-config-store.js";
import { SqliteSystemEventStore } from "../../src/adapters/sqlite-system-event-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";

/**
 * 平台环境约束 API 契约（知识体系轮 P1）：admin 读写 /api/admin/platform-notes，
 * member 403；保存后 app_config platform.envNotes 生效（orchestrator 每轮现取）。
 */

let web: WebChannel;
let db: Database.Database;
let tmpDir: string;
let userStore: SqliteUserStore;
let moduleConfigStore: SqliteModuleConfigStore;
let sessionStore: JwtSessionStore;

async function startChannel(): Promise<number> {
  db = new Database(":memory:");
  sessionStore = new JwtSessionStore(db, "platform-notes-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir: tmpDir });
  userStore.migrate();
  userStore.migrateCredentials();
  const systemEventStore = new SqliteSystemEventStore(db);
  systemEventStore.migrate();
  moduleConfigStore = new SqliteModuleConfigStore(db, "notes-seed");
  moduleConfigStore.migrate();
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    systemEventStore,
    moduleConfigStore,
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

async function get(port: number, token: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/admin/platform-notes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function put(port: number, token: string, notes: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/admin/platform-notes`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ notes }),
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "donger-notes-"));
});
afterEach(() => {
  web.stop();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET/PUT /api/admin/platform-notes", () => {
  it("member 403（越权必测项）", async () => {
    const port = await startChannel();
    const member = await makeUser("member");
    expect((await get(port, member.token)).status).toBe(403);
    expect((await put(port, member.token, "x")).status).toBe(403);
  });

  it("admin 读默认空 → 保存 → 回读一致，app_config 落值", async () => {
    const port = await startChannel();
    const admin = await makeUser("boss", "admin");
    expect(((await (await get(port, admin.token)).json()) as { notes: string }).notes).toBe("");
    const putRes = await put(port, admin.token, "## 平台环境约束\n- 沙箱无 python");
    expect(putRes.status).toBe(200);
    expect(((await (await get(port, admin.token)).json()) as { notes: string }).notes).toBe(
      "## 平台环境约束\n- 沙箱无 python",
    );
    expect(moduleConfigStore.getFlag("platform.envNotes")).toBe(
      "## 平台环境约束\n- 沙箱无 python",
    );
  });

  it("非法请求体 400（notes 非字符串）", async () => {
    const port = await startChannel();
    const admin = await makeUser("boss2", "admin");
    const r = await fetch(`http://127.0.0.1:${port}/api/admin/platform-notes`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ notes: 42 }),
    });
    expect(r.status).toBe(400);
  });
});
