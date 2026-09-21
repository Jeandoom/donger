import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { createTestModuleConfigStore } from "../util/module-config-test-helper.js";

// 钉钉 API 外呼 mock：state 强校验应在触达钉钉前拒绝（规格 M4）
vi.mock("../../src/util/dingtalk-api.js", () => ({
  getUserAccessToken: vi.fn(async () => {
    throw new Error("should not be called when state invalid");
  }),
  getUserInfoByOAuth: vi.fn(async () => {
    throw new Error("should not be called");
  }),
}));

let web: WebChannel;
let db: Database.Database;
let usersDir: string;
let tmpDir: string;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  usersDir = mkdtempSync(join(tmpdir(), "dd-users-"));
  tmpDir = mkdtempSync(join(tmpdir(), "dd-ws-"));
  db = new Database(":memory:");
  const sessionStore = new JwtSessionStore(db, "dd-secret");
  sessionStore.migrate();
  const userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
  userStore.migrate();
  userStore.migrateCredentials();
  const moduleConfigStore = createTestModuleConfigStore(db);
  moduleConfigStore.putDingTalk({ appKey: "ak", appSecret: "sk" });
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    moduleConfigStore,
  });
  web.onMessage(() => {});
  await web.ready();
});

afterEach(() => {
  void web?.stop();
  db?.close();
  rmSync(usersDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("钉钉 OAuth state 强校验（M4：CSRF 拒绝而非仅告警）", () => {
  it("无 state / 未知 state / 过期 state → 302 错误且不外呼钉钉 API", async () => {
    const port = web.boundPort;
    if (!port) throw new Error("no port");
    for (const qs of ["code=c1", "code=c2&state=forged", "code=c3&state=expired-state"]) {
      const res = await realFetch(`http://127.0.0.1:${port}/api/auth/dingtalk/callback?${qs}`, {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      const loc = res.headers.get("location") ?? "";
      expect(loc).toContain("/login?error=");
      expect(loc).toContain(encodeURIComponent("登录会话已过期"));
    }
  });

  it("有效 state → 走正常流程（外呼钉钉 API 失败时 302 error，而非 state 拦截）", async () => {
    const port = web.boundPort;
    if (!port) throw new Error("no port");
    // 取一个真实签发的 state（qrcode-url 端点）
    const qr = await realFetch(`http://127.0.0.1:${port}/api/auth/qrcode-url`);
    const { url } = (await qr.json()) as { url: string };
    const state = new URL(url).searchParams.get("state") ?? "";
    expect(state).toBeTruthy();
    const res = await realFetch(
      `http://127.0.0.1:${port}/api/auth/dingtalk/callback?code=c&state=${state}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    // mock 的钉钉 API 抛错 → error=；证明流程通过了 state 关卡
    expect(res.headers.get("location") ?? "").toContain("/login?error=");
  });
});
