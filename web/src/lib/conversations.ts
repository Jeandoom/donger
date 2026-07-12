import type { ConversationSummary } from "../types";

/** 默认会话（未绑定智能体） */
export function isDefaultConv(c: Pick<ConversationSummary, "agentId">): boolean {
  return !c.agentId || c.agentId === "";
}

/** 属于指定智能体的会话 */
export function isAgentConv(c: Pick<ConversationSummary, "agentId">, agentId: string): boolean {
  return c.agentId === agentId;
}
