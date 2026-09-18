import { z } from "zod";

/** 任务评论（T17.3 观测/反馈闭环）：验收门可带评论落库，task-optimize 聚合为优化输入 */
export const CommentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  userId: z.string(),
  text: z.string().min(1),
  createdAt: z.string(),
});
export type Comment = z.infer<typeof CommentSchema>;
