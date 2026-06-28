import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import type { User, UserRole } from "../domain/user.js";
import type { UserStore } from "../ports/user-store.js";

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
  }

  async getOrCreate(staffId: string, name: string): Promise<User> {
    const existing = await this.getByStaffId(staffId);
    if (existing) return existing;

    const id = crypto.randomUUID();
    const role: UserRole = this.opts.adminStaffIds.has(staffId) ? "admin" : "user";
    const homeDir = join(this.opts.usersDir, id);
    const now = new Date().toISOString();
    const user: User = { id, staffId, name, role, homeDir, createdAt: now, updatedAt: now };

    // 初始化 homeDir
    mkdirSync(join(homeDir, "repos"), { recursive: true });
    mkdirSync(join(homeDir, "memory"), { recursive: true });

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
}
