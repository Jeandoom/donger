import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { jwtVerify, SignJWT } from "jose";
import type { SessionStore } from "../ports/session-store.js";

/**
 * JWT 会话存储（jose 实现，替代手写 HS256）。
 * alg/签名校验交给库（杜绝 alg 混淆与时序侧信道）；黑名单（revoked_tokens）语义不变。
 */
export class JwtSessionStore implements SessionStore {
  private readonly key: Uint8Array;

  constructor(
    private readonly db: Database,
    secret: string,
    private readonly ttlMs: number = 30 * 24 * 60 * 60 * 1000,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS revoked_tokens (
        jti TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        revokedAt TEXT NOT NULL
      )
    `);
    // 启动时清理已过期的 revoked token
    const cutoff = new Date(Date.now() - this.ttlMs).toISOString();
    this.db.prepare("DELETE FROM revoked_tokens WHERE revokedAt < ?").run(cutoff);
  }

  async create(userId: string): Promise<{ token: string; jti: string }> {
    const jti = randomUUID();
    const token = await new SignJWT({ jti })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(`${Math.floor(this.ttlMs / 1000)}s`)
      .sign(this.key);
    return { token, jti };
  }

  async verify(token: string): Promise<string | null> {
    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(token, this.key, { algorithms: ["HS256"] });
      payload = result.payload as Record<string, unknown>;
    } catch {
      return null;
    }
    // 检查黑名单
    const jti = payload.jti as string | undefined;
    if (!jti) return null;
    const revoked = this.db.prepare("SELECT 1 FROM revoked_tokens WHERE jti = ?").get(jti);
    if (revoked) return null;
    return payload.sub as string;
  }

  async revoke(jti: string): Promise<void> {
    this.db
      .prepare("INSERT OR IGNORE INTO revoked_tokens (jti, userId, revokedAt) VALUES (?, ?, ?)")
      .run(jti, "", new Date().toISOString());
  }

  async isRevoked(jti: string): Promise<boolean> {
    const row = this.db.prepare("SELECT 1 FROM revoked_tokens WHERE jti = ?").get(jti);
    return !!row;
  }
}
