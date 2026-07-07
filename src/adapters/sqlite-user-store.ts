import { join } from "node:path";
import type { Database } from "better-sqlite3";
import type { User, UserIdentity, UserRole } from "../domain/user.js";
import type { UserStore } from "../ports/user-store.js";
import { initUserWorkspace } from "../util/workspace.js";

export interface SqliteUserStoreOptions {
  /**
   * 管理员的外部 ID 集合（来自 ADMIN_EXTERNAL_IDS 配置）。
   * 值是钉钉 userId（扫码用）或 staffId（IM 用），逗号分隔。
   */
  adminExternalIds: Set<string>;
  /** 用户目录根（如 data/users/） */
  usersDir: string;
}

/** SQLite 持久化的 UserStore。首次自动创建用户 + 初始化 homeDir。 */
export class SqliteUserStore implements UserStore {
  constructor(
    private readonly db: Database,
    private readonly opts: SqliteUserStoreOptions,
  ) {}

  migrate(): void {
    // 旧版 donger 的 users 表带 `staffId TEXT UNIQUE NOT NULL`；
    // 新代码 INSERT users 不再写 staffId，会违反 NOT NULL。
    // SQLite 不支持 ALTER COLUMN，故检测旧 schema 并重建表（幂等）。
    this.upgradeUsersSchema();
    // users 表保留 staffId 列以兼容既有数据库（SQLite 不支持 DROP COLUMN）；
    // 新代码不再写入 staffId。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        staffId TEXT,
        data TEXT NOT NULL,
        role TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_identities (
        id          TEXT PRIMARY KEY,
        userId      TEXT NOT NULL,
        provider    TEXT NOT NULL,
        externalId  TEXT NOT NULL,
        unionId     TEXT,
        name        TEXT,
        avatar      TEXT,
        rawProfile  TEXT,
        createdAt   TEXT NOT NULL
      )
    `);
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_provider_external ON user_identities(provider, externalId)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_user_identities_userId ON user_identities(userId)",
    );
  }

  /**
   * 检测旧版 users 表（staffId 带 NOT NULL/UNIQUE 约束）并重建为新版（staffId 可空）。
   * 幂等：已是新版或表不存在则跳过。SQLite 不支持 DROP/ALTER COLUMN，只能重建表。
   */
  private upgradeUsersSchema(): void {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
      .get() as { sql: string } | undefined;
    if (!row?.sql) return; // 表不存在 → 由后续 CREATE TABLE IF NOT EXISTS 建
    // 旧 schema 判定：staffId 列声明里含 NOT NULL 或 UNIQUE
    const staffIdDecl = /staffId\s+TEXT\s+([^,]*)/i.exec(row.sql)?.[1] ?? "";
    if (!/NOT\s+NULL|UNIQUE/i.test(staffIdDecl)) return;

    const rebuild = this.db.transaction(() => {
      this.db.exec(
        "CREATE TABLE users_new (id TEXT PRIMARY KEY, staffId TEXT, data TEXT NOT NULL, role TEXT NOT NULL, updatedAt TEXT NOT NULL)",
      );
      this.db.exec(
        "INSERT INTO users_new (id, staffId, data, role, updatedAt) SELECT id, staffId, data, role, updatedAt FROM users",
      );
      this.db.exec("DROP TABLE users");
      this.db.exec("ALTER TABLE users_new RENAME TO users");
    });
    rebuild();
  }

  async get(id: string): Promise<User | undefined> {
    const row = this.db.prepare("SELECT data FROM users WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as User) : undefined;
  }

  /** 按 provider+externalId 查找用户；找不到就创建并绑定 identity */
  async getOrCreateByIdentity(
    provider: string,
    externalId: string,
    name?: string,
    avatar?: string,
  ): Promise<User> {
    // 1. 查 user_identities
    const row = this.db
      .prepare("SELECT userId FROM user_identities WHERE provider = ? AND externalId = ?")
      .get(provider, externalId) as { userId: string } | undefined;
    if (row) {
      const existing = await this.get(row.userId);
      if (existing) return existing;
    }
    // 2. 新建 User
    const id = crypto.randomUUID();
    const role: UserRole = this.opts.adminExternalIds.has(externalId) ? "admin" : "user";
    const homeDir = join(this.opts.usersDir, id);
    const now = new Date().toISOString();
    const user: User = {
      id,
      name: name ?? "unknown",
      role,
      homeDir,
      createdAt: now,
      updatedAt: now,
    };

    // 初始化 homeDir（工作区目录树：定义/运行时/知识 三类）
    initUserWorkspace(homeDir);

    this.db
      .prepare("INSERT INTO users (id, data, role, updatedAt) VALUES (?, ?, ?, ?)")
      .run(user.id, JSON.stringify(user), user.role, user.updatedAt);

    // 3. 写 identity
    await this.addIdentity(user.id, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      userId: user.id,
      provider,
      externalId,
      name,
      avatar,
      createdAt: now,
    });
    return user;
  }

  /** 检查外部 ID 是否在管理员白名单中 */
  async isAdminByExternalId(externalId: string): Promise<boolean> {
    return this.opts.adminExternalIds.has(externalId);
  }

  async updateRole(id: string, role: UserRole): Promise<void> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`user 不存在: ${id}`);
    const updated: User = { ...cur, role, updatedAt: new Date().toISOString() };
    this.db
      .prepare("UPDATE users SET data = ?, role = ?, updatedAt = ? WHERE id = ?")
      .run(JSON.stringify(updated), role, updated.updatedAt, id);
  }

  async list(): Promise<User[]> {
    const rows = this.db.prepare("SELECT data FROM users ORDER BY updatedAt DESC").all() as {
      data: string;
    }[];
    return rows.map((r) => JSON.parse(r.data) as User);
  }

  // ---- 新增方法 ----

  async findByIdentity(provider: string, externalId: string): Promise<User | undefined> {
    const row = this.db
      .prepare("SELECT userId FROM user_identities WHERE provider = ? AND externalId = ?")
      .get(provider, externalId) as { userId: string } | undefined;
    if (!row) return undefined;
    return this.get(row.userId);
  }

  async addIdentity(userId: string, identity: UserIdentity): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO user_identities (id, userId, provider, externalId, unionId, name, avatar, rawProfile, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        identity.id,
        identity.userId,
        identity.provider,
        identity.externalId,
        identity.unionId ?? null,
        identity.name ?? null,
        identity.avatar ?? null,
        identity.rawProfile ?? null,
        identity.createdAt,
      );
  }

  async getIdentities(userId: string): Promise<UserIdentity[]> {
    const rows = this.db
      .prepare("SELECT * FROM user_identities WHERE userId = ? ORDER BY createdAt")
      .all(userId) as Array<{
      id: string;
      userId: string;
      provider: string;
      externalId: string;
      unionId: string | null;
      name: string | null;
      avatar: string | null;
      rawProfile: string | null;
      createdAt: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      provider: r.provider,
      externalId: r.externalId,
      unionId: r.unionId ?? undefined,
      name: r.name ?? undefined,
      avatar: r.avatar ?? undefined,
      rawProfile: r.rawProfile ?? undefined,
      createdAt: r.createdAt,
    }));
  }

  async updateProfile(id: string, partial: Partial<Pick<User, "name" | "avatar">>): Promise<void> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`user 不存在: ${id}`);
    const updated: User = { ...cur, ...partial, updatedAt: new Date().toISOString() };
    this.db
      .prepare("UPDATE users SET data = ?, updatedAt = ? WHERE id = ?")
      .run(JSON.stringify(updated), updated.updatedAt, id);
  }
}
