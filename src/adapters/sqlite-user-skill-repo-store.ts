import type { Database } from "better-sqlite3";
import type {
  SkillRepoSyncStatus,
  UserSkillRepoConfig,
  UserSkillRepoInput,
} from "../domain/user-skill-repo.js";
import type { UserSkillRepoStore } from "../ports/user-skill-repo-store.js";

type Row = Record<string, unknown>;

export class SqliteUserSkillRepoStore implements UserSkillRepoStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_skill_repos (
        userId TEXT PRIMARY KEY,
        repoUrl TEXT NOT NULL, credentialCode TEXT NOT NULL, branch TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        lastSyncAt TEXT, lastSyncStatus TEXT, lastSyncError TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
    `);
  }

  async get(userId: string): Promise<UserSkillRepoConfig | undefined> {
    const r = this.db.prepare("SELECT * FROM user_skill_repos WHERE userId = ?").get(userId) as
      | Row
      | undefined;
    return r ? this.rowToConfig(r) : undefined;
  }

  async upsert(userId: string, input: UserSkillRepoInput): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO user_skill_repos
         (userId,repoUrl,credentialCode,branch,enabled,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(userId) DO UPDATE SET
           repoUrl=excluded.repoUrl, credentialCode=excluded.credentialCode,
           branch=excluded.branch, enabled=excluded.enabled,
           lastSyncAt=NULL, lastSyncStatus=NULL, lastSyncError=NULL,
           updatedAt=excluded.updatedAt`,
      )
      .run(
        userId,
        input.repoUrl,
        input.credentialCode,
        input.branch,
        input.enabled ? 1 : 0,
        now,
        now,
      );
  }

  async remove(userId: string): Promise<void> {
    this.db.prepare("DELETE FROM user_skill_repos WHERE userId = ?").run(userId);
  }

  async setSyncStatus(
    userId: string,
    patch: { at: string; status: SkillRepoSyncStatus; error?: string },
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE user_skill_repos
         SET lastSyncAt = ?, lastSyncStatus = ?, lastSyncError = ?, updatedAt = ?
         WHERE userId = ?`,
      )
      .run(patch.at, patch.status, patch.error ?? null, new Date().toISOString(), userId);
  }

  private rowToConfig(r: Row): UserSkillRepoConfig {
    return {
      userId: r.userId as string,
      repoUrl: r.repoUrl as string,
      credentialCode: r.credentialCode as string,
      branch: r.branch as string,
      enabled: r.enabled === 1,
      ...(typeof r.lastSyncAt === "string" ? { lastSyncAt: r.lastSyncAt } : {}),
      ...(typeof r.lastSyncStatus === "string"
        ? { lastSyncStatus: r.lastSyncStatus as SkillRepoSyncStatus }
        : {}),
      ...(typeof r.lastSyncError === "string" ? { lastSyncError: r.lastSyncError } : {}),
      createdAt: r.createdAt as string,
      updatedAt: r.updatedAt as string,
    };
  }
}
