import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { createTestModuleConfigStore } from "../util/module-config-test-helper.js";

/** GET /api/auth/methods 契约：按授权模块配置返回可用登录方式（顺序=展示优先级）+ setup 状态 */

let web: WebChannel;
let db: Database.Database;
let usersDir: string;
let tmpDir: string;

async function startChannel(
  opts: Partial<{
    dingtalk: { appKey: string; appSecret: string };
    github: { clientId: string; clientSecret: string };
    emailLoginEnabled: boolean;
    /** 模拟未完成初始化的裸库（默认写 setup_completed 标记=已完成，聚焦 methods 本身） */
    bareSetup?: boolean;
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
  const store = createTestModuleConfigStore(db);
  if (opts.dingtalk) store.putDingTalk(opts.dingtalk);
  if (opts.github) store.putGithub(opts.github);
  if (opts.emailLoginEnabled !== undefined) {
    store.putEmail({ signupAllowedDomains: [], loginEnabled: opts.emailLoginEnabled });
  }
  if (!opts.bareSetup) store.setFlag("setup_completed", new Date().toISOString());
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    moduleConfigStore: store,
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
    expect(await res.json()).toEqual({ methods: ["email"], setupRequired: false });
  });

  it("钉钉/GitHub 均配置 → 三者按 邮箱>钉钉>GitHub 优先级返回", async () => {
    const port = await startChannel({
      dingtalk: { appKey: "ak", appSecret: "as" },
      github: { clientId: "cid", clientSecret: "secret" },
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/methods`);
    expect(await res.json()).toEqual({
      methods: ["email", "dingtalk", "github"],
      setupRequired: false,
    });
  });

  it("仅钉钉配置 → 邮箱+钉钉（不含 GitHub）", async () => {
    const port = await startChannel({ dingtalk: { appKey: "ak", appSecret: "as" } });
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/methods`);
    expect(await res.json()).toEqual({ methods: ["email", "dingtalk"], setupRequired: false });
  });

  it("emailLoginEnabled=false → 隐藏邮箱，仅返回已配置的 OAuth 方式", async () => {
    const port = await startChannel({
      dingtalk: { appKey: "ak", appSecret: "as" },
      github: { clientId: "cid", clientSecret: "secret" },
      emailLoginEnabled: false,
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/methods`);
    expect(await res.json()).toEqual({
      methods: ["dingtalk", "github"],
      setupRequired: false,
    });
  });

  it("全部关闭 → 空列表（登录页据此提示未配置）", async () => {
    const port = await startChannel({ emailLoginEnabled: false });
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/methods`);
    expect(await res.json()).toEqual({ methods: [], setupRequired: false });
  });

  it("裸库（无 admin 无标记）→ setupRequired=true（前端据此强制 /setup）", async () => {
    const port = await startChannel({ bareSetup: true });
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/methods`);
    expect(await res.json()).toEqual({ methods: ["email"], setupRequired: true });
  });
});
