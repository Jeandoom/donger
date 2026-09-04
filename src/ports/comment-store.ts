import type { Comment } from "../domain/comment.js";

/** 任务评论存储（T17.3 唯一新端口；spec §7.2） */
export interface CommentStore {
  add(taskId: string, userId: string, text: string): Promise<Comment>;
  listByTask(taskId: string): Promise<Comment[]>;
}
