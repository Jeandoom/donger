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

function newStore(adminExternalIds: string[] = []): SqliteUserStore {
  const s = new SqliteUserStore(db, {
    adminExternalIds: new Set(adminExternalIds),
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

  it("hasAnyAdminExcluding：排除指定用户后判定剩余 admin", async () => {
    const s = newStore();
    const a = await s.getOrCreateByIdentity("dingtalk", "a", "甲");
    const b = await s.getOrCreateByIdentity("dingtalk", "b", "乙");
    await s.updateRole(a.id, "admin");
    await s.updateRole(b.id, "admin");
    expect(await s.hasAnyAdminExcluding(a.id)).toBe(true); // 还有 b
    await s.updateRole(b.id, "user");
    expect(await s.hasAnyAdminExcluding(a.id)).toBe(false); // 只剩 a 自己
    expect(await s.hasAnyAdminExcluding(b.id)).toBe(true); // a 仍是 admin
    await s.updateRole(a.id, "user");
    expect(await s.hasAnyAdminExcluding(b.id)).toBe(false); // 全员 user
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
      const s1 = new SqliteUserStore(db1, { adminExternalIds: new Set(), usersDir });
      s1.migrate();
      await s1.getOrCreateByIdentity("dingtalk", "persist-ext", "持久");
      db1.close();
      const db2 = new Database(dbPath);
      const s2 = new SqliteUserStore(db2, { adminExternalIds: new Set(), usersDir });
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

  it("provider:externalId 前缀命中 → role=admin；同裸 id 在其他平台 → user", async () => {
    const s = newStore(["github:8888"]);
    const gh = await s.getOrCreateByIdentity("github", "8888", "GH");
    expect(gh.role).toBe("admin");
    const dd = await s.getOrCreateByIdentity("dingtalk", "8888", "DD");
    expect(dd.role).toBe("user");
  });
});

describe("isAdminByExternalId", () => {
  it("externalId 在白名单内 → true", async () => {
    const s = newStore(["ext1"]);
    expect(await s.isAdminByExternalId("dingtalk", "ext1")).toBe(true);
  });

  it("不在白名单 → false", async () => {
    const s = newStore();
    expect(await s.isAdminByExternalId("dingtalk", "ext1")).toBe(false);
  });

  it("provider:externalId 前缀仅对对应 provider 生效", async () => {
    const s = newStore(["github:8888"]);
    expect(await s.isAdminByExternalId("github", "8888")).toBe(true);
    expect(await s.isAdminByExternalId("dingtalk", "8888")).toBe(false);
  });
});

describe("schema 迁移：旧 users 表（staffId NOT NULL）→ 新表", () => {
  /** 模拟旧版 donger 创建的 users 表（staffId UNIQUE NOT NULL）+ 历史用户 */
  function seedLegacySchema(): void {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        staffId TEXT UNIQUE NOT NULL,
        data TEXT NOT NULL,
        role TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec("CREATE INDEX idx_users_staffId ON users(staffId)");
    const legacy = {
      id: "legacy-1",
      staffId: "mGPkjiPkLEiSdZLWytvFVQDQiEiE",
      name: "测试用户",
      role: "user",
      homeDir: usersDir,
      createdAt: "t",
      updatedAt: "t",
    };
    db.prepare("INSERT INTO users (id, staffId, data, role, updatedAt) VALUES (?,?,?,?,?)").run(
      legacy.id,
      legacy.staffId,
      JSON.stringify(legacy),
      legacy.role,
      legacy.updatedAt,
    );
  }

  it("migrate 把旧表升级为 staffId 可空，历史数据保留", async () => {
    seedLegacySchema();
    const s = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
    s.migrate();

    // 历史用户仍在
    const legacy = await s.get("legacy-1");
    expect(legacy?.name).toBe("测试用户");

    // 关键：新代码 INSERT users 不带 staffId 必须能成功（旧 schema 下会违反 NOT NULL）
    const user = await s.getOrCreateByIdentity("dingtalk", "new-ext", "新用户");
    expect(user.id).toBeTruthy();
    expect(user.name).toBe("新用户");
  });

  it("升级后 users 表 staffId 列可空（PRAGMA 确认约束已放宽）", () => {
    seedLegacySchema();
    const s = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
    s.migrate();
    const cols = db.prepare("PRAGMA table_info(users)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const staffIdCol = cols.find((c) => c.name === "staffId");
    expect(staffIdCol?.notnull).toBe(0);
  });

  it("migrate 幂等：连续执行两次不破坏数据", async () => {
    seedLegacySchema();
    const s = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
    s.migrate();
    s.migrate(); // 第二次
    const legacy = await s.get("legacy-1");
    expect(legacy?.name).toBe("测试用户");
  });

  it("全新 DB（无 users 表）→ 直接建新 schema，staffId 可空", async () => {
    const s = newStore();
    const user = await s.getOrCreateByIdentity("dingtalk", "ext1", "Alice");
    expect(user.id).toBeTruthy();
    const cols = db.prepare("PRAGMA table_info(users)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(cols.find((c) => c.name === "staffId")?.notnull).toBe(0);
  });
});
