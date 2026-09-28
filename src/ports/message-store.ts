import type { StoredMessage } from "../domain/types.js";

/**
 * 消息存储端口：按会话持久化聊天消息（用户消息 + Bot 回复）。
 * 支持在切换历史会话时重新加载消息记录。
 */
export interface MessageStore {
  /** 添加一条消息（taskId 可选：bot 消息归属的任务，供回合合并/装饰）。
   *  约定：落库实现应把所属会话的 updatedAt 刷新为该消息时间（会话活跃度 = 最后一条消息）
   *  opts.createdAt：回填历史时间戳（zcode 轮末对账补录叙述用，specs/2026-09-29-zcode-record-fidelity-design.md
   *  M2）。消息 createdAt 用回填值保证时间正序；会话 updatedAt 仍刷为墙钟 now，防回填旧时间把活跃会话沉底。 */
  add(
    conversationId: string,
    role: "user" | "bot",
    text: string,
    files?: string,
    taskId?: string,
    opts?: { createdAt?: string },
  ): Promise<StoredMessage>;

  /** 按 conversationId 获取所有消息（按时间正序） */
  listByConversation(conversationId: string): Promise<StoredMessage[]>;
}
