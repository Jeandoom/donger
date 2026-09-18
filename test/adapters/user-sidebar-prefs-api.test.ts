import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as Db } from "better-sqlite3";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";

let web: WebChannel | undefined;
let db: Db | undefined;

afterEach(async () => {
  await web?.stop();
  db?.close();
  web = undefined;
  db = undefined;
});

async function setup(): Promise<{
  port: number;
  token: string;
  userStore: SqliteUserStore;
  userId: string;
}> {
  db = new Database(":memory:");
  const tmp = mkdtempSync(join(tmpdir(), "sidebar-prefs-"));
  const userStore = new SqliteUserStore(db, {
    adminExternalIds: new Set(),
    usersDir: join(tmp, "users"),
  });
  userStore.migrate();
  const user = await userStore.getOrCreateByIdentity("internal", "sidebar-user", "用户");
  const sessionStore = new JwtSessionStore(db, "test-secret");
  sessionStore.migrate();
  const { token } = await sessionStore.create(user.id);
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: join(tmp, "web"),
    userStore,
    sessionStore,
  });
  // onMessage 负责创建 HTTP server（见 WebChannel.onMessage），必须先于 ready() 调用
  web.onMessage(() => {});
  await web.ready();
  const port = web.boundPort;
  if (!port) throw new Error("web server 未启动");
  return { port, token, userStore, userId: user.id };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("对话模块侧栏偏好 API（PATCH /api/users/me/sidebar-prefs）", () => {
  it("合法偏好 → 200 且随 User 持久化", async () => {
    const { port, token, userStore, userId } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/api/users/me/sidebar-prefs`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ starredAgentIds: ["a1", "a2"], agentOrder: ["a3", "a4"] }),
    });
    expect(res.status).toBe(200);
    const stored = await userStore.get(userId);
    expect(stored?.starredAgentIds).toEqual(["a1", "a2"]);
    expect(stored?.agentOrder).toEqual(["a3", "a4"]);
  });

  it("重复 id 去重落库", async () => {
    const { port, token, userStore, userId } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/api/users/me/sidebar-prefs`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ starredAgentIds: ["a1", "a1"], agentOrder: ["a2", "a2", "a3"] }),
    });
    expect(res.status).toBe(200);
    const stored = await userStore.get(userId);
    expect(stored?.starredAgentIds).toEqual(["a1"]);
    expect(stored?.agentOrder).toEqual(["a2", "a3"]);
  });

  it("非法载荷（非字符串数组）→ 400 且不落库", async () => {
    const { port, token, userStore, userId } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/api/users/me/sidebar-prefs`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ starredAgentIds: "a1", agentOrder: [] }),
    });
    expect(res.status).toBe(400);
    const stored = await userStore.get(userId);
    expect(stored?.starredAgentIds).toBeUndefined();
  });

  it("未登录 → 401", async () => {
    const { port } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/api/users/me/sidebar-prefs`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starredAgentIds: [], agentOrder: [] }),
    });
    expect(res.status).toBe(401);
  });
});
