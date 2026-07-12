import { z } from "zod";

export const ConversationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  sdkSessionId: z.string(),
  title: z.string(),
  channelId: z.string(),
  agentId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean(),
});
export type Conversation = z.infer<typeof ConversationSchema>;
