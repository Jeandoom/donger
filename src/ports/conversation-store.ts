import type { Conversation } from "../domain/conversation.js";

export interface ConversationStore {
  /** 创建新会话（sdkSessionId 初始为空，首次 query 后回写；agentId 为空=默认对话） */
  create(userId: string, channelId: string, title: string): Promise<Conversation>;
  /** 创建绑定到指定智能体的会话 */
  createWithAgent(
    userId: string,
    channelId: string,
    title: string,
    agentId: string,
  ): Promise<Conversation>;
  /** 按 ID 查 */
  get(id: string): Promise<Conversation | undefined>;
  /** 列出用户未归档会话（最新在前） */
  listByUser(userId: string): Promise<Conversation[]>;
  /** 取用户最新未归档会话 */
  getLatest(userId: string, channelId: string): Promise<Conversation | undefined>;
  /** 更新（回写 sdkSessionId / title / archived） */
  update(id: string, patch: Partial<Conversation>): Promise<void>;
}
