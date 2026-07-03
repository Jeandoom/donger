import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import type { User, UserIdentity, UserRole } from "../domain/user.js";
import type { UserStore } from "../ports/user-store.js";
import { initUserWorkspace } from "../util/workspace.js";

export interface SqliteUserStoreOptions {
  /** 管理员的 staffId 集合（来自 ADMIN_STAFF_IDS 配置） */
  adminStaffIds: Set<string>;
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        staffId TEXT UNIQUE NOT NULL,
        data TEXT NOT NULL,
        role TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_users_staffId ON users(staffId)");
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
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_provider_external ON user_identities(provider, externalId)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_user_identities_userId ON user_identities(userId)");
  }

  async getOrCreate(staffId: string, name: string): Promise<User> {
    const existing = await this.getByStaffId(staffId);
    if (existing) return existing;

    const id = crypto.randomUUID();
    const role: UserRole = this.opts.adminStaffIds.has(staffId) ? "admin" : "user";
    const homeDir = join(this.opts.usersDir, id);
    const now = new Date().toISOString();
    const user: User = { id, staffId, name, role, homeDir, createdAt: now, updatedAt: now };

    // 初始化 homeDir（工作区目录树：定义/运行时/知识 三类）
    initUserWorkspace(homeDir);

    this.db
      .prepare("INSERT INTO users (id, staffId, data, role, updatedAt) VALUES (?, ?, ?, ?, ?)")
      .run(user.id, user.staffId, JSON.stringify(user), user.role, user.updatedAt);
    return user;
  }

  async get(id: string): Promise<User | undefined> {
    const row = this.db.prepare("SELECT data FROM users WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as User) : undefined;
  }

  async getByStaffId(staffId: string): Promise<User | undefined> {
    const row = this.db.prepare("SELECT data FROM users WHERE staffId = ?").get(staffId) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as User) : undefined;
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
        identity.id, identity.userId, identity.provider, identity.externalId,
        identity.unionId ?? null, identity.name ?? null, identity.avatar ?? null,
        identity.rawProfile ?? null, identity.createdAt,
      );
  }

  async getIdentities(userId: string): Promise<UserIdentity[]> {
    const rows = this.db
      .prepare("SELECT * FROM user_identities WHERE userId = ? ORDER BY createdAt")
      .all(userId) as Array<{
      id: string; userId: string; provider: string; externalId: string;
      unionId: string | null; name: string | null; avatar: string | null;
      rawProfile: string | null; createdAt: string;
    }>;
    return rows.map((r) => ({
      id: r.id, userId: r.userId, provider: r.provider, externalId: r.externalId,
      unionId: r.unionId ?? undefined, name: r.name ?? undefined, avatar: r.avatar ?? undefined,
      rawProfile: r.rawProfile ?? undefined, createdAt: r.createdAt,
    }));
  }

  async mergeUsers(sourceId: string, targetId: string): Promise<void> {
    const trx = this.db.transaction(() => {
      // 1. identity 重新指向
      this.db.prepare("UPDATE user_identities SET userId = ? WHERE userId = ?")
        .run(targetId, sourceId);
      // 2. conversations 重新指向（表可能不存在）
      try {
        this.db.prepare("UPDATE conversations SET userId = ? WHERE userId = ?")
          .run(targetId, sourceId);
      } catch { /* 表不存在则跳过 */ }
      // 3. usage_records 重新指向
      try {
        this.db.prepare("UPDATE usage_records SET user_id = ? WHERE user_id = ?")
          .run(targetId, sourceId);
      } catch { /* 跳过 */ }
      // 4. audit_events 重新指向
      try {
        this.db.prepare("UPDATE audit_events SET userId = ? WHERE userId = ?")
          .run(targetId, sourceId);
      } catch { /* 跳过 */ }
      // 5. 更新 target 的 mergedFrom
      const targetData = this.db.prepare("SELECT data FROM users WHERE id = ?").get(targetId) as { data: string } | undefined;
      const sourceData = this.db.prepare("SELECT data FROM users WHERE id = ?").get(sourceId) as { data: string } | undefined;
      if (targetData && sourceData) {
        const target = JSON.parse(targetData.data) as User;
        const source = JSON.parse(sourceData.data) as User;
        const mergedFrom = [...(target.mergedFrom ?? []), sourceId];
        const updated = { ...target, mergedFrom, updatedAt: new Date().toISOString() };
        this.db.prepare("UPDATE users SET data = ?, updatedAt = ? WHERE id = ?")
          .run(JSON.stringify(updated), updated.updatedAt, targetId);

        // 合并工作区文件（source 的 knowledge_base → target 的 knowledge_base）
        const sourceKb = join(source.homeDir, "knowledge_base");
        const targetKb = join(target.homeDir, "knowledge_base");
        this.mergeDirRecursive(sourceKb, targetKb);
      }
    });
    trx();
  }

  async updateProfile(id: string, partial: Partial<Pick<User, "name" | "avatar">>): Promise<void> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`user 不存在: ${id}`);
    const updated: User = { ...cur, ...partial, updatedAt: new Date().toISOString() };
    this.db
      .prepare("UPDATE users SET data = ?, updatedAt = ? WHERE id = ?")
      .run(JSON.stringify(updated), updated.updatedAt, id);
  }

  private mergeDirRecursive(src: string, dest: string): void {
    if (!existsSync(src)) return;
    mkdirSync(dest, { recursive: true });
    const { readdirSync, copyFileSync, statSync } = require("node:fs");
    const entries = readdirSync(src);
    for (const entry of entries) {
      const srcPath = join(src, entry);
      const destPath = join(dest, entry);
      if (statSync(srcPath).isDirectory()) {
        this.mergeDirRecursive(srcPath, destPath);
      } else if (!existsSync(destPath)) {
        // 同名文件优先保留 target 版本
        copyFileSync(srcPath, destPath);
      }
    }
  }
}