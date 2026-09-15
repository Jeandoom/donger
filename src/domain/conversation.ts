import { z } from "zod";
import { AgentPermissionModeSchema } from "./permission-mode.js";

export const ConversationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  sdkSessionId: z.string(),
  title: z.string(),
  channelId: z.string(),
  agentId: z.string(),
  /** 会话权限模式覆盖；空 = 跟随绑定智能体的 defaultPermissionMode */
  permissionMode: AgentPermissionModeSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean(),
});
export type Conversation = z.infer<typeof ConversationSchema>;
