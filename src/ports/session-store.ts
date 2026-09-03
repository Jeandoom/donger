export interface SessionStore {
  /** 为用户创建 JWT，返回 token 字符串和 jti（JWT ID） */
  create(userId: string): Promise<{ token: string; jti: string }>;
  /** 校验 token，返回 userId。过期/无效/已撤销返回 null */
  verify(token: string): Promise<string | null>;
  /** 撤销 JWT（主动登出） */
  revoke(jti: string): Promise<void>;
  /** 检查 JWT 是否已被撤销 */
  isRevoked(jti: string): Promise<boolean>;
}
