import type { Database } from "better-sqlite3";
import type { Invite } from "../domain/invite.js";
import type { InviteStore } from "../ports/invite-store.js";

interface InviteRow {
  id: string;
  token: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  usedCount: number;
  disabled: number;
}

function rowToInvite(r: InviteRow): Invite {
  return {
    id: r.id,
    token: r.token,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    maxUses: r.maxUses,
    usedCount: r.usedCount,
    disabled: r.disabled === 1,
  };
}

export class SqliteInviteStore implements InviteStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_invites (
        id         TEXT PRIMARY KEY,
        token      TEXT NOT NULL UNIQUE,
        createdBy  TEXT NOT NULL,
        createdAt  TEXT NOT NULL,
        expiresAt  TEXT NOT NULL,
        maxUses    INTEGER NOT NULL,
        usedCount  INTEGER NOT NULL DEFAULT 0,
        disabled   INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_user_invites_createdBy ON user_invites(createdBy)",
    );
  }

  async create(invite: Invite): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO user_invites (id, token, createdBy, createdAt, expiresAt, maxUses, usedCount, disabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        invite.id,
        invite.token,
        invite.createdBy,
        invite.createdAt,
        invite.expiresAt,
        invite.maxUses,
        invite.usedCount,
        invite.disabled ? 1 : 0,
      );
  }

  async getByToken(token: string): Promise<Invite | undefined> {
    const row = this.db.prepare("SELECT * FROM user_invites WHERE token = ?").get(token) as
      | InviteRow
      | undefined;
    return row ? rowToInvite(row) : undefined;
  }

  async listByCreator(userId: string): Promise<Invite[]> {
    const rows = this.db
      .prepare("SELECT * FROM user_invites WHERE createdBy = ? ORDER BY createdAt DESC")
      .all(userId) as InviteRow[];
    return rows.map(rowToInvite);
  }

  async consume(token: string, now: Date): Promise<boolean> {
    const r = this.db
      .prepare(
        `UPDATE user_invites SET usedCount = usedCount + 1
         WHERE token = ? AND disabled = 0 AND usedCount < maxUses AND expiresAt > ?`,
      )
      .run(token, now.toISOString());
    return r.changes > 0;
  }

  async disable(id: string, createdBy: string): Promise<boolean> {
    const r = this.db
      .prepare("UPDATE user_invites SET disabled = 1 WHERE id = ? AND createdBy = ?")
      .run(id, createdBy);
    return r.changes > 0;
  }
}
