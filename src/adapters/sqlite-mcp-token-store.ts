import { createHash, randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { McpTokenIssue, McpTokenRecord, McpTokenStore } from "../ports/mcp-token-store.js";

const TOKEN_PREFIX = "dgk_";
/** lastUsedAt 回写节流窗口 */
const TOUCH_THROTTLE_MS = 60_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hintOf(token: string): string {
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

function rowToRecord(row: {
  id: string;
  user_id: string;
  name: string;
  token_hint: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}): McpTokenRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    tokenHint: row.token_hint,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

/** McpTokenStore 的 SQLite 实现：哈希唯一索引命中即鉴权，失败不计（防爆破靠网关/限流） */
export class SqliteMcpTokenStore implements McpTokenStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tokens (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        name         TEXT NOT NULL,
        token_hash   TEXT NOT NULL UNIQUE,
        token_hint   TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        expires_at   TEXT,
        revoked_at   TEXT,
        last_used_at TEXT
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON mcp_tokens(user_id)");
  }

  issue(userId: string, name: string, expiresInDays: number | null): Promise<McpTokenIssue> {
    const token = `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
    const record: McpTokenRecord = {
      id: randomBytes(12).toString("hex"),
      userId,
      name,
      tokenHint: hintOf(token),
      createdAt: new Date().toISOString(),
      expiresAt:
        expiresInDays !== null
          ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString()
          : null,
      revokedAt: null,
      lastUsedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO mcp_tokens (id, user_id, name, token_hash, token_hint, created_at, expires_at, revoked_at, last_used_at)
         VALUES (?,?,?,?,?,?,?,?,NULL)`,
      )
      .run(
        record.id,
        record.userId,
        record.name,
        sha256(token),
        record.tokenHint,
        record.createdAt,
        record.expiresAt,
        null,
      );
    return Promise.resolve({ record, token });
  }

  listByUser(userId: string): Promise<McpTokenRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT id, user_id, name, token_hint, created_at, expires_at, revoked_at, last_used_at
         FROM mcp_tokens WHERE user_id = ? ORDER BY created_at DESC`,
      )
      .all(userId) as Parameters<typeof rowToRecord>[0][];
    return Promise.resolve(rows.map(rowToRecord));
  }

  revoke(userId: string, tokenId: string): Promise<boolean> {
    const info = this.db
      .prepare(
        `UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      )
      .run(new Date().toISOString(), tokenId, userId);
    return Promise.resolve(info.changes > 0);
  }

  verify(token: string): Promise<{ userId: string; tokenId: string } | undefined> {
    if (!token.startsWith(TOKEN_PREFIX)) return Promise.resolve(undefined);
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `SELECT id, user_id, expires_at, revoked_at FROM mcp_tokens
         WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(sha256(token), now) as
      | { id: string; user_id: string; expires_at: string | null; revoked_at: string | null }
      | undefined;
    if (!row) return Promise.resolve(undefined);
    // 节流回写最后使用时间（一条 UPDATE，命中窗口即跳过）
    this.db
      .prepare(
        `UPDATE mcp_tokens SET last_used_at = ?
         WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
      )
      .run(now, row.id, new Date(Date.now() - TOUCH_THROTTLE_MS).toISOString());
    return Promise.resolve({ userId: row.user_id, tokenId: row.id });
  }
}
