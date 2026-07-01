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
  it("getOrCreate：首次创建 + homeDir 初始化工作区目录树", async () => {
    const s = newStore();
    const user = await s.getOrCreate("staff1", "张三");
    expect(user.staffId).toBe("staff1");
    expect(user.name).toBe("张三");
    expect(user.role).toBe("user");
    expect(existsSync(join(user.homeDir, "sessions"))).toBe(true);
    expect(existsSync(join(user.homeDir, "knowledge_base", "user"))).toBe(true);
    expect(existsSync(join(user.homeDir, ".skills", ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("getOrCreate：admin staffId → role=admin", async () => {
    const s = newStore(["boss-staff"]);
    const user = await s.getOrCreate("boss-staff", "老板");
    expect(user.role).toBe("admin");
  });

  it("getOrCreate：第二次返回已存在的（不重复创建）", async () => {
    const s = newStore();
    const u1 = await s.getOrCreate("staff1", "张三");
    const u2 = await s.getOrCreate("staff1", "张三改名");
    expect(u2.id).toBe(u1.id);
    // name 不变（getOrCreate 不更新已存在的）
    expect(u2.name).toBe("张三");
  });

  it("getByStaffId", async () => {
    const s = newStore();
    await s.getOrCreate("staff1", "张三");
    expect((await s.getByStaffId("staff1"))?.name).toBe("张三");
    expect(await s.getByStaffId("nope")).toBeUndefined();
  });

  it("updateRole", async () => {
    const s = newStore();
    const u = await s.getOrCreate("staff1", "张三");
    await s.updateRole(u.id, "admin");
    expect((await s.get(u.id))?.role).toBe("admin");
  });

  it("list", async () => {
    const s = newStore();
    await s.getOrCreate("a", "甲");
    await s.getOrCreate("b", "乙");
    expect((await s.list()).length).toBe(2);
  });

  it("持久化：重新打开同一 DB 用户仍在", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "donger-userdb-"));
    const dbPath = join(tmp, "test.db");
    try {
      const db1 = new Database(dbPath);
      const s1 = new SqliteUserStore(db1, { adminStaffIds: new Set(), usersDir });
      s1.migrate();
      await s1.getOrCreate("persist-staff", "持久");
      db1.close();
      const db2 = new Database(dbPath);
      const s2 = new SqliteUserStore(db2, { adminStaffIds: new Set(), usersDir });
      s2.migrate();
      expect((await s2.getByStaffId("persist-staff"))?.name).toBe("持久");
      db2.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
