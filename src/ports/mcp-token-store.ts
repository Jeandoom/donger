/**
 * MCP 接入令牌端口（spec 2026-09-24-mcp-auth-files-design §2）：
 * 每用户可签发多个接入令牌，供 zcode / Codex / Claude Code 等外部 agent 以
 * Bearer 方式访问 /mcp 端点；令牌权限即属主用户在 web 端的权限。
 * 令牌明文只在签发响应中出现一次，库存 SHA-256 哈希。
 */

export interface McpTokenRecord {
  id: string;
  userId: string;
  name: string;
  /** 展示用提示（前 8 位 + … + 后 4 位），不可用于鉴权 */
  tokenHint: string;
  createdAt: string;
  /** null = 无限期 */
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface McpTokenIssue {
  record: McpTokenRecord;
  /** 明文令牌（仅签发时返回一次） */
  token: string;
}

export interface McpTokenStore {
  /** 签发令牌；expiresInDays 为 null 表示无限期 */
  issue(userId: string, name: string, expiresInDays: number | null): Promise<McpTokenIssue>;
  listByUser(userId: string): Promise<McpTokenRecord[]>;
  /** 吊销（属主校验由调用方保证；返回是否确有此属主令牌被吊销） */
  revoke(userId: string, tokenId: string): Promise<boolean>;
  /** Bearer 校验：命中且未吊销未过期则回属主；副作用：节流回写 lastUsedAt（60s） */
  verify(token: string): Promise<{ userId: string; tokenId: string } | undefined>;
}
