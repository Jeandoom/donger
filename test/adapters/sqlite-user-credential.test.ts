import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { hashPassword } from "../../src/util/password.js";

let usersDir: string;
let db: Database.Database;

beforeEach(() => {
  usersDir = mkdtempSync(join(tmpdir(), "donger-cred-"));
  db = new Database(":memory:");
});
afterEach(() => {
  db.close();
  rmSync(usersDir, { recursive: true, force: true });
});

function newStore(): SqliteUserStore {
  const s = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
  s.migrate();
  s.migrateCredentials();
  return s;
}

describe("邮箱密码凭证", () => {
  it("set → get 往返；重复 set 覆盖", async () => {
    const s = newStore();
    const u = await s.getOrCreateByIdentity("email", "a@x.com", "a");
    expect(await s.getPasswordCredential(u.id)).toBeUndefined();
    await s.setPasswordCredential(u.id, hashPassword("abc12345"));
    expect(await s.getPasswordCredential(u.id)).toBeDefined();
    await s.setPasswordCredential(u.id, hashPassword("zzzz9999"));
    const stored = (await s.getPasswordCredential(u.id)) ?? "";
    expect(stored.startsWith("scrypt$")).toBe(true);
  });

  it("凭据表独立于 users.data JSON（不随 get 序列化泄露）", async () => {
    const s = newStore();
    const u = await s.getOrCreateByIdentity("email", "b@x.com", "b");
    await s.setPasswordCredential(u.id, hashPassword("abc12345"));
    const raw = await s.get(u.id);
    expect(JSON.stringify(raw)).not.toContain("scrypt$");
  });
});
