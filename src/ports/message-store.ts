import type { StoredMessage } from "../domain/types.js";

/**
 * 消息存储端口：按会话持久化聊天消息（用户消息 + Bot 回复）。
 * 支持在切换历史会话时重新加载消息记录。
 */
export interface MessageStore {
  /** 添加一条消息（taskId 可选：bot 消息归属的任务，供回合合并/装饰） */
  add(
    conversationId: string,
    role: "user" | "bot",
    text: string,
    files?: string,
    taskId?: string,
  ): Promise<StoredMessage>;

  /** 按 conversationId 获取所有消息（按时间正序） */
  listByConversation(conversationId: string): Promise<StoredMessage[]>;
}
