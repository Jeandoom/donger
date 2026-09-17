/**
 * 智能体回调链接端口：agent 级回调凭证（token 与 agent 一一绑定，URL 即凭证）。
 * 参见 docs/superpowers/specs/2026-09-15-agent-callback-design.md。
 */
export interface AgentCallback {
  token: string;
  agentId: string;
  /** 冗余存智能体主人，审计归因用 */
  ownerId: string;
  /** ISO 时间；null = 不过期 */
  expiresAt: string | null;
  createdAt: string;
}

export interface AgentCallbackStore {
  /** 查某智能体当前的回调配置（无则 undefined） */
  get(agentId: string): Promise<AgentCallback | undefined>;
  /** 按 token 反查（回调 GET 端点入口） */
  findByToken(token: string): Promise<AgentCallback | undefined>;
  /** 生成/重新生成：新 token + 重算有效期，旧链接立即失效 */
  upsert(agentId: string, ownerId: string, validityDays?: number): Promise<AgentCallback>;
  /** 吊销（删除配置行） */
  /** 记录该 token 最近一次发起的回调会话（结果查询绑定用） */
  recordConversation(token: string, conversationId: string): Promise<void>;
  /** 读取绑定会话；未绑定的旧行返回 undefined */
  getLastConversationId(token: string): Promise<string | undefined>;
  revoke(agentId: string): Promise<void>;
}
