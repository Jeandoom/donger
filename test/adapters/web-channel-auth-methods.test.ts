import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";

/** GET /api/auth/methods 契约：按 .env 装配的配置返回可用登录方式（顺序=展示优先级） */

let web: WebChannel;
let db: Database.Database;
let usersDir: string;
let tmpDir: string;

async function startChannel(
  opts: Partial<{
    dingtalkConfig: { appKey: string; appSecret: string };
    githubConfig: { clientId: string; clientSecret: string };
    emailLoginEnabled: boolean;
  }> = {},
): Promise<number> {
  db = new Database(":memory:");
  const sessionStore = new JwtSessionStore(db, "test-secret");
  sessionStore.migrate();
  const userStore = new SqliteUserStore(db, {
    adminExternalIds: new Set(),
    usersDir,
  });
  userStore.migrate();
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    ...opts,
  });
  web.onMessage(() => {});
  await web.ready();
  const port = web.boundPort;
  if (!port) throw new Error("server not listening");
  return port;
}

beforeEach(() => {
  usersDir = mkdtempSync(join(tmpdir(), "methods-users-"));
  tmpDir = mkdtempSync(join(tmpdir(), "methods-ws-"));
});

afterEach(() => {
  void web?.stop();
  db?.close();
  rmSync(usersDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/auth/methods", () => {
  it("无任何 OAuth 配置 → 仅邮箱（内置默认开启）", async () => {
    const port = await startChannel();
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/methods`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ methods: ["email"] });
  });

  it("钉钉/GitHub 均配置 → 三者按 邮箱>钉钉>GitHub 优先级返回", async () => {
    const port = await startChannel({
      dingtalkConfig: { appKey: "ak", appSecret: "as" },
      githubConfig: { clientId: "cid", clientSecret: "secret" },
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/methods`);
    expect(await res.json()).toEqual({ methods: ["email", "dingtalk", "github"] });
  });

  it("仅钉钉配置 → 邮箱+钉钉（不含 GitHub）", async () => {
    const port = await startChannel({
      dingtalkConfig: { appKey: "ak", appSecret: "as" },
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/methods`);
    expect(await res.json()).toEqual({ methods: ["email", "dingtalk"] });
  });

  it("emailLoginEnabled=false → 隐藏邮箱，仅返回已配置的 OAuth 方式", async () => {
    const port = await startChannel({
      dingtalkConfig: { appKey: "ak", appSecret: "as" },
      githubConfig: { clientId: "cid", clientSecret: "secret" },
      emailLoginEnabled: false,
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/methods`);
    expect(await res.json()).toEqual({ methods: ["dingtalk", "github"] });
  });

  it("全部关闭 → 空列表（登录页据此提示未配置）", async () => {
    const port = await startChannel({ emailLoginEnabled: false });
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/methods`);
    expect(await res.json()).toEqual({ methods: [] });
  });
});
