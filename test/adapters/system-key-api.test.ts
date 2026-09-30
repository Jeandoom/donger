import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { resolveSystemKeySeed, SystemKeyService } from "../../src/adapters/system-key-service.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";
import { createTestModuleConfigStore } from "../util/module-config-test-helper.js";

/**
 * 系统密钥管理路由契约：admin 守卫 fail-closed + 状态/轮换端到端。
 * 守卫表漏登记会表现为 404，这里以真实 HTTP 调用兜住该类回归。
 */

let web: WebChannel;
let db: Database.Database;
let usersDir: string;
let tmpDir: string;
let userStore: SqliteUserStore;
let sessionStore: JwtSessionStore;
const realFetch = globalThis.fetch;

async function startChannel(): Promise<void> {
  db = new Database(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  sessionStore = new JwtSessionStore(db, "verify-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
  userStore.migrate();
  userStore.migrateCredentials();
  const boot = resolveSystemKeySeed(db, "");
  const systemKey = new SystemKeyService(db, createSecretCipher(boot.seed), "f".repeat(64), "");
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    moduleConfigStore: createTestModuleConfigStore(db),
    systemKey,
  });
  web.onMessage(() => {});
  await web.ready();
  if (!web.boundPort) throw new Error("server not listening");
}

async function tokenFor(externalId: string, role?: "admin"): Promise<string> {
  const user = await userStore.getOrCreateByIdentity("test", externalId, externalId);
  if (role) await userStore.updateRole(user.id, role);
  const { token } = await sessionStore.create(user.id);
  return token;
}

beforeEach(() => {
  usersDir = mkdtempSync(join(tmpdir(), "syskey-users-"));
  tmpDir = mkdtempSync(join(tmpdir(), "syskey-ws-"));
});
afterEach(() => {
  void web?.stop();
  db?.close();
  rmSync(usersDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("系统密钥管理路由", () => {
  it("admin：状态可读 → 一键轮换 → 指纹变化且历史换头", async () => {
    await startChannel();
    const token = await tokenFor("root", "admin");

    const s1 = await realFetch(`http://127.0.0.1:${web.boundPort}/api/admin/secret-key`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(s1.status).toBe(200);
    const status1 = (await s1.json()) as {
      fingerprint: string;
      source: string;
      history: unknown[];
    };
    expect(status1.source).toBe("generated");
    expect(status1.history).toHaveLength(1);

    const rot = await realFetch(`http://127.0.0.1:${web.boundPort}/api/admin/secret-key/rotate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ generate: true }),
    });
    expect(rot.status).toBe(200);
    const rotated = (await rot.json()) as { fingerprint: string; report: { healed: number } };
    expect(rotated.fingerprint).not.toBe(status1.fingerprint);

    const s2 = await realFetch(`http://127.0.0.1:${web.boundPort}/api/admin/secret-key`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const status2 = (await s2.json()) as {
      fingerprint: string;
      history: Array<{ retiredAt: string | null }>;
    };
    expect(status2.fingerprint).toBe(rotated.fingerprint);
    expect(status2.history).toHaveLength(2);
    expect(status2.history.filter((h) => h.retiredAt !== null)).toHaveLength(1);
  });

  it("非 admin → 403；守卫表漏登记会以 404 在本用例暴露", async () => {
    await startChannel();
    const token = await tokenFor("alice");
    const r = await realFetch(`http://127.0.0.1:${web.boundPort}/api/admin/secret-key`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(403);
  });

  it("轮换参数非法 → 400 带原因", async () => {
    await startChannel();
    const token = await tokenFor("root", "admin");
    const r = await realFetch(`http://127.0.0.1:${web.boundPort}/api/admin/secret-key/rotate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ newValue: "   " }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error?: string };
    expect(body.error).toContain("不能为空");
  });
});
