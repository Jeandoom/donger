import { createHmac, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { SessionStore } from "../ports/session-store.js";

export class JwtSessionStore implements SessionStore {
  constructor(
    private readonly db: Database,
    private readonly secret: string,
    private readonly ttlMs: number = 30 * 24 * 60 * 60 * 1000,
  ) {}

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
    const now = Math.floor(Date.now() / 1000);
    const payload = { sub: userId, jti, iat: now, exp: now + Math.floor(this.ttlMs / 1000) };
    const token = this.encodeJwt(payload);
    return { token, jti };
  }

  async verify(token: string): Promise<string | null> {
    try {
      const payload = this.decodeJwt(token);
      if (!payload) return null;
      // 检查过期
      if (payload.exp && (payload.exp as number) * 1000 < Date.now()) return null;
      // 检查黑名单
      const revoked = this.db
        .prepare("SELECT 1 FROM revoked_tokens WHERE jti = ?")
        .get(payload.jti);
      if (revoked) return null;
      return payload.sub as string;
    } catch {
      return null;
    }
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

  private encodeJwt(payload: Record<string, unknown>): string {
    const header = { alg: "HS256", typ: "JWT" };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", this.secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");
    return `${headerB64}.${payloadB64}.${sig}`;
  }

  private decodeJwt(token: string): Record<string, unknown> | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // length 已验证为 3，默认值仅为满足类型（不会触发）
    const [headerB64 = "", payloadB64 = "", sigB64 = ""] = parts;
    const expectedSig = createHmac("sha256", this.secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");
    if (sigB64 !== expectedSig) return null;
    return JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  }
}
