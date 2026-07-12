import type { Database } from "better-sqlite3";
import type { CredentialEntry, CredentialStore } from "../ports/credential-store.js";
import { decryptValue, encryptValue } from "../util/skill-crypto.js";

export class SqliteCredentialStore implements CredentialStore {
  constructor(
    private readonly db: Database,
    private readonly keyHex: string,
  ) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_credentials (
        userId TEXT NOT NULL, key TEXT NOT NULL,
        ciphertext TEXT NOT NULL, label TEXT, updatedAt TEXT NOT NULL,
        PRIMARY KEY (userId, key)
      );
    `);
  }

  async list(userId: string): Promise<CredentialEntry[]> {
    const rows = this.db
      .prepare("SELECT key, label, updatedAt FROM user_credentials WHERE userId = ?")
      .all(userId) as Array<{ key: string; label: string | null; updatedAt: string }>;
    return rows.map((r) => ({ key: r.key, label: r.label ?? undefined, updatedAt: r.updatedAt }));
  }

  async getMany(userId: string, keys: string[]): Promise<Record<string, string>> {
    if (keys.length === 0) return {};
    const placeholders = keys.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT key, ciphertext FROM user_credentials WHERE userId = ? AND key IN (${placeholders})`,
      )
      .all(userId, ...keys) as Array<{ key: string; ciphertext: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) {
      try {
        out[r.key] = decryptValue(this.keyHex, r.ciphertext);
      } catch {
        // 跳过损坏项
      }
    }
    return out;
  }

  async setValue(userId: string, key: string, value: string, label?: string): Promise<void> {
    const ct = encryptValue(this.keyHex, value);
    this.db
      .prepare(
        `INSERT INTO user_credentials (userId,key,ciphertext,label,updatedAt)
         VALUES (?,?,?,?,?)
         ON CONFLICT(userId,key) DO UPDATE SET
           ciphertext=excluded.ciphertext, label=excluded.label, updatedAt=excluded.updatedAt`,
      )
      .run(userId, key, ct, label ?? null, new Date().toISOString());
  }

  async deleteValue(userId: string, key: string): Promise<void> {
    this.db.prepare("DELETE FROM user_credentials WHERE userId = ? AND key = ?").run(userId, key);
  }
}
