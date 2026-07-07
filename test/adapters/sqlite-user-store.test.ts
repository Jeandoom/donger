import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";

let usersDir: string;
let db: Database.Database;

beforeEach(() => {
  usersDir = mkdtempSync(join(tmpdir(), "donger-users-"));
  db = new Database(":memory:");
});
afterEach(() => {
  db.close();
  rmSync(usersDir, { recursive: true, force: true });
});

function newStore(adminStaffIds: string[] = []): SqliteUserStore {
  const s = new SqliteUserStore(db, {
    adminStaffIds: new Set(adminStaffIds),
    usersDir,
  });
  s.migrate();
  return s;
}

describe("SqliteUserStore", () => {
  it("get：返回 undefined（不存在）", async () => {
    const s = newStore();
    expect(await s.get("nope")).toBeUndefined();
  });

  it("updateRole", async () => {
    const s = newStore();
    const u = await s.getOrCreateByIdentity("dingtalk", "ext1", "张三");
    await s.updateRole(u.id, "admin");
    expect((await s.get(u.id))?.role).toBe("admin");
  });

  it("list", async () => {
    const s = newStore();
    await s.getOrCreateByIdentity("dingtalk", "a", "甲");
    await s.getOrCreateByIdentity("dingtalk", "b", "乙");
    expect((await s.list()).length).toBe(2);
  });

  it("持久化：重新打开同一 DB 用户仍在", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "donger-userdb-"));
    const dbPath = join(tmp, "test.db");
    try {
      const db1 = new Database(dbPath);
      const s1 = new SqliteUserStore(db1, { adminStaffIds: new Set(), usersDir });
      s1.migrate();
      await s1.getOrCreateByIdentity("dingtalk", "persist-ext", "持久");
      db1.close();
      const db2 = new Database(dbPath);
      const s2 = new SqliteUserStore(db2, { adminStaffIds: new Set(), usersDir });
      s2.migrate();
      expect((await s2.findByIdentity("dingtalk", "persist-ext"))?.name).toBe("持久");
      db2.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("SqliteUserStore identity", () => {
  it("findByIdentity：不存在返回 undefined", async () => {
    const s = newStore();
    const found = await s.findByIdentity("dingtalk", "staff-none");
    expect(found).toBeUndefined();
  });

  it("addIdentity + findByIdentity", async () => {
    const s = newStore();
    const user = await s.getOrCreateByIdentity("dingtalk", "staff1", "张三");
    await s.addIdentity(user.id, {
      id: "id-1",
      userId: user.id,
      provider: "feishu",
      externalId: "open-1",
      name: "张三",
      avatar: "https://avatar.example.com/1",
      createdAt: new Date().toISOString(),
    });
    const found = await s.findByIdentity("feishu", "open-1");
    expect(found?.id).toBe(user.id);
  });

  it("getIdentities 返回用户所有 identity", async () => {
    const s = newStore();
    const user = await s.getOrCreateByIdentity("dingtalk", "staff1", "张三");
    await s.addIdentity(user.id, {
      id: "id-2",
      userId: user.id,
      provider: "feishu",
      externalId: "open-1",
      createdAt: new Date().toISOString(),
    });
    const identities = await s.getIdentities(user.id);
    expect(identities.length).toBe(2);
    expect(identities.map((i) => i.provider).sort()).toEqual(["dingtalk", "feishu"]);
  });
});

describe("getOrCreateByIdentity", () => {
  it("首次 (provider,externalId) 不存在 → 新建 User + 写入 identity", async () => {
    const s = newStore();
    const user = await s.getOrCreateByIdentity("dingtalk", "ext1", "Alice");
    expect(user.id).toBeTruthy();
    expect(user.name).toBe("Alice");
    expect(user.role).toBe("user");
    expect(existsSync(join(user.homeDir, "sessions"))).toBe(true);
    const found = await s.findByIdentity("dingtalk", "ext1");
    expect(found?.id).toBe(user.id);
  });

  it("已存在 → 直接返回已有 User", async () => {
    const s = newStore();
    const a = await s.getOrCreateByIdentity("dingtalk", "ext1", "Alice");
    const b = await s.getOrCreateByIdentity("dingtalk", "ext1", "Bob");
    expect(b.id).toBe(a.id);
    // name 不更新（已存在）
    expect(b.name).toBe("Alice");
  });

  it("不同 provider 的同 externalId → 不同 User（各自 identity）", async () => {
    const s = newStore();
    const a = await s.getOrCreateByIdentity("dingtalk", "ext1", "Alice");
    const b = await s.getOrCreateByIdentity("feishu", "ext1", "Alice2");
    expect(a.id).not.toBe(b.id);
  });

  it("externalId 在白名单内 → role=admin", async () => {
    const s = newStore(["ext1"]);
    const user = await s.getOrCreateByIdentity("dingtalk", "ext1", "Alice");
    expect(user.role).toBe("admin");
  });
});

describe("isAdminByExternalId", () => {
  it("externalId 在白名单内 → true", async () => {
    const s = newStore(["ext1"]);
    expect(await s.isAdminByExternalId("ext1")).toBe(true);
  });

  it("不在白名单 → false", async () => {
    const s = newStore();
    expect(await s.isAdminByExternalId("ext1")).toBe(false);
  });
});
