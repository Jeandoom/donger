import { createHash } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

/**
 * 应用作用域令牌（app-token；spec §7.1 + 分发面 §7.2）。
 *
 * 密钥从平台 JWT secret 派生（sha256(secret + ":app-token-v1")），与主会话 JWT
 * 密钥空间隔离：app-token 过不了 sessionStore.verify，主 JWT 也过不了本服务校验，
 * 两类令牌不可互逆兑换。
 *
 * claims：
 *  - sub = 访问者 userId（anonymous 档为常量 "anonymous"）
 *  - aud = appId（应用作用域的根；app-data 等运行时端点据此隔离）
 *  - scope = owner（属主，读写）| viewer（grants/all-users，只读）| anonymous（公开匿名，只读）
 *  - typ = "app"（双保险标记）
 *
 * 三档统一 60 分钟短时效：分享收回（access 改回 private / 移出名单）后，
 * 已签发令牌最多再活一个 TTL——撤销延迟上界 = 60min，不做长时效令牌。
 */

const APP_TOKEN_TTL_SECONDS = 60 * 60;

export type AppTokenScope = "owner" | "viewer" | "anonymous";

export interface AppTokenClaims {
  userId: string;
  appId: string;
  scope: AppTokenScope;
}

const SCOPES: ReadonlySet<string> = new Set(["owner", "viewer", "anonymous"]);

export class AppTokenService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly ttlSeconds = APP_TOKEN_TTL_SECONDS,
  ) {
    this.key = new Uint8Array(createHash("sha256").update(`${secret}:app-token-v1`).digest());
  }

  async issue(claims: AppTokenClaims): Promise<{ token: string; expiresIn: number }> {
    const token = await new SignJWT({ scope: claims.scope, typ: "app" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(claims.userId)
      .setAudience(claims.appId)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key);
    return { token, expiresIn: this.ttlSeconds };
  }

  /** 校验并返回 claims；非法/过期/aud 不符返回 null（不区分原因，防探测） */
  async verify(token: string, appId: string): Promise<AppTokenClaims | null> {
    try {
      const result = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        audience: appId,
        requiredClaims: ["sub", "aud"],
      });
      const payload = result.payload as Record<string, unknown>;
      if (payload.typ !== "app") return null;
      const scope = payload.scope;
      if (typeof scope !== "string" || !SCOPES.has(scope)) return null;
      const sub = payload.sub;
      if (typeof sub !== "string" || !sub) return null;
      return { userId: sub, appId, scope: scope as AppTokenScope };
    } catch {
      return null;
    }
  }
}
