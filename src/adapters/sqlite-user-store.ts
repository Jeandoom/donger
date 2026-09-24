import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { EMAIL_VERIFY_TTL_MS } from "../domain/invite.js";
import {
  isAdminExternalId,
  type SidebarPrefs,
  type User,
  type UserIdentity,
  type UserRole,
} from "../domain/user.js";
import type { EmailVerificationState, UserStore } from "../ports/user-store.js";
import { initUserWorkspace } from "../util/workspace.js";

export interface SqliteUserStoreOptions {
  /**
   * 管理员的外部 ID 集合（来自 ADMIN_EXTERNAL_IDS 配置）。
   * 条目为裸 externalId（全平台生效）或 "provider:externalId"（限定平台）。
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
    // setup 引导标记所在表（index.ts 的 jwt_secret 亦复用；此处兜底保证单测裸库可用）
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
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
    const role: UserRole = isAdminExternalId(this.opts.adminExternalIds, provider, externalId)
      ? "admin"
      : "user";
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

  /** 检查外部 ID 是否在管理员白名单中（含 provider:externalId 前缀条目） */
  async isAdminByExternalId(provider: string, externalId: string): Promise<boolean> {
    return isAdminExternalId(this.opts.adminExternalIds, provider, externalId);
  }

  // ---- 邮箱注册的密码凭证（独立表，避免哈希进 users.data JSON 被 API 序列化） ----

  migrateCredentials(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_email_credentials (
        userId       TEXT PRIMARY KEY,
        passwordHash TEXT NOT NULL,
        updatedAt    TEXT NOT NULL
      )
    `);
    // 邮箱验证状态机（规格 §6.1）：幂等补列
    const cols = (
      this.db.prepare("PRAGMA table_info(user_email_credentials)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (!cols.includes("verified")) {
      this.db.exec(
        "ALTER TABLE user_email_credentials ADD COLUMN verified INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!cols.includes("verifyToken")) {
      this.db.exec("ALTER TABLE user_email_credentials ADD COLUMN verifyToken TEXT");
    }
    if (!cols.includes("verifyExpiresAt")) {
      this.db.exec("ALTER TABLE user_email_credentials ADD COLUMN verifyExpiresAt TEXT");
    }
    // 存量账号批量置 pending（裁决②：上线不宽限）——仅对"从未发放过 token"的未验证行
    // 发放验证凭据（24h 窗口，自本次启动起算）；已有 token 的行与已验证行不受重启影响
    const cutoff = new Date(Date.now() + EMAIL_VERIFY_TTL_MS).toISOString();
    this.db
      .prepare(
        `UPDATE user_email_credentials
         SET verifyToken = ?, verifyExpiresAt = ?
         WHERE verified = 0 AND verifyToken IS NULL`,
      )
      .run(randomBytes(24).toString("base64url"), cutoff);
  }

  async setPasswordCredential(userId: string, passwordHash: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO user_email_credentials (userId, passwordHash, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(userId) DO UPDATE SET passwordHash = excluded.passwordHash, updatedAt = excluded.updatedAt`,
      )
      .run(userId, passwordHash, new Date().toISOString());
  }

  async getPasswordCredential(userId: string): Promise<string | undefined> {
    const row = this.db
      .prepare("SELECT passwordHash FROM user_email_credentials WHERE userId = ?")
      .get(userId) as { passwordHash: string } | undefined;
    return row?.passwordHash;
  }

  async setEmailVerification(
    userId: string,
    v: { token: string; expiresAt: string },
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE user_email_credentials
         SET verified = 0, verifyToken = ?, verifyExpiresAt = ?
         WHERE userId = ?`,
      )
      .run(v.token, v.expiresAt, userId);
  }

  async getEmailVerification(userId: string): Promise<EmailVerificationState | undefined> {
    const row = this.db
      .prepare(
        "SELECT verified, verifyToken, verifyExpiresAt FROM user_email_credentials WHERE userId = ?",
      )
      .get(userId) as
      | { verified: number; verifyToken: string | null; verifyExpiresAt: string | null }
      | undefined;
    if (!row) return undefined;
    return { verified: row.verified === 1, token: row.verifyToken, expiresAt: row.verifyExpiresAt };
  }

  async markEmailVerified(token: string): Promise<string | undefined> {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `UPDATE user_email_credentials
         SET verified = 1, verifyToken = NULL, verifyExpiresAt = NULL
         WHERE verifyToken = ? AND verified = 0 AND verifyExpiresAt IS NOT NULL AND verifyExpiresAt > ?
         RETURNING userId`,
      )
      .get(token, now) as { userId: string } | undefined;
    return row?.userId;
  }

  async listEmailVerifications(): Promise<
    Array<{
      userId: string;
      email: string | undefined;
      verified: boolean;
      expiresAt: string | null;
      token: string | null;
    }>
  > {
    const rows = this.db
      .prepare(
        `SELECT c.userId, c.verified, c.verifyToken, c.verifyExpiresAt, i.externalId AS email
         FROM user_email_credentials c
         LEFT JOIN user_identities i ON i.userId = c.userId AND i.provider = 'email'
         ORDER BY c.updatedAt DESC`,
      )
      .all() as Array<{
      userId: string;
      verified: number;
      verifyToken: string | null;
      verifyExpiresAt: string | null;
      email: string | undefined;
    }>;
    return rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      verified: r.verified === 1,
      expiresAt: r.verifyExpiresAt,
      token: r.verifyToken,
    }));
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

  // ---- 零配置引导（spec 2026-09-21-auth-module-design §3.4） ----

  async hasAnyAdmin(): Promise<boolean> {
    const row = this.db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
    return !!row;
  }

  async hasAnyAdminExcluding(id: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT 1 FROM users WHERE role = 'admin' AND id != ? LIMIT 1")
      .get(id);
    return !!row;
  }

  /** 原子降级：守卫复核 + 写入同事务（better-sqlite3 同步事务，无 await 让出窗口）。
   * 两步写法在并发互降下可把 admin 清零（2026-09-24 审计），降级路径必须走这里。 */
  async demoteAdminGuarded(id: string): Promise<"ok" | "last-admin"> {
    const tx = this.db.transaction((): "ok" | "last-admin" => {
      const another = this.db
        .prepare("SELECT 1 FROM users WHERE role = 'admin' AND id != ? LIMIT 1")
        .get(id);
      if (!another) return "last-admin";
      const row = this.db.prepare("SELECT data FROM users WHERE id = ?").get(id) as
        | { data: string }
        | undefined;
      if (!row) throw new Error(`user 不存在: ${id}`);
      const cur = JSON.parse(row.data) as User;
      const updated: User = { ...cur, role: "user", updatedAt: new Date().toISOString() };
      this.db
        .prepare("UPDATE users SET data = ?, role = ?, updatedAt = ? WHERE id = ?")
        .run(JSON.stringify(updated), "user", updated.updatedAt, id);
      return "ok";
    });
    return tx.immediate();
  }

  async createBootstrapAdmin(input: {
    email: string;
    passwordHash: string;
  }): Promise<"created" | "exists"> {
    const tx = this.db.transaction((): "created" | "exists" => {
      const adminRow = this.db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
      if (adminRow) return "exists";
      const flag = this.db
        .prepare("SELECT value FROM app_config WHERE key = 'setup_completed'")
        .get();
      if (flag) return "exists";
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const user: User = {
        id,
        name: input.email.split("@")[0] ?? input.email,
        role: "admin",
        homeDir: join(this.opts.usersDir, id),
        createdAt: now,
        updatedAt: now,
      };
      initUserWorkspace(user.homeDir);
      this.db
        .prepare("INSERT INTO users (id, data, role, updatedAt) VALUES (?, ?, ?, ?)")
        .run(user.id, JSON.stringify(user), user.role, now);
      this.db
        .prepare(
          "INSERT INTO user_identities (id, userId, provider, externalId, name, createdAt) VALUES (?, ?, 'email', ?, ?, ?)",
        )
        .run(`${Date.now()}-bootstrap`, user.id, input.email, user.name, now);
      this.db
        .prepare(
          "INSERT INTO user_email_credentials (userId, passwordHash, updatedAt, verified) VALUES (?, ?, ?, 1)",
        )
        .run(user.id, input.passwordHash, now);
      this.db
        .prepare(
          "INSERT INTO app_config (key, value) VALUES ('setup_completed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(now);
      return "created";
    });
    return tx();
  }

  // ---- 新增方法 ----

  async findByIdentity(provider: string, externalId: string): Promise<User | undefined> {
    const row = this.db
      .prepare("SELECT userId FROM user_identities WHERE provider = ? AND externalId = ?")
      .get(provider, externalId) as { userId: string } | undefined;
    if (!row) return undefined;
    return this.get(row.userId);
  }

  async addIdentity(_userId: string, identity: UserIdentity): Promise<void> {
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

  async updateSidebarPrefs(id: string, prefs: SidebarPrefs): Promise<void> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`user 不存在: ${id}`);
    // 去重防御：客户端可容忍，服务端不落脏数据
    const updated: User = {
      ...cur,
      starredAgentIds: [...new Set(prefs.starredAgentIds)],
      agentOrder: [...new Set(prefs.agentOrder)],
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare("UPDATE users SET data = ?, updatedAt = ? WHERE id = ?")
      .run(JSON.stringify(updated), updated.updatedAt, id);
  }
}
