import type { ChatMessage } from "../types";

/** 内置协助智能体 ID（与后端 src/orchestrator/assist-agent.ts 保持一致） */
export const BUILTIN_ASSIST_AGENT_ID = "builtin-assist";

/** 兜底草稿的 sessionStorage key（入口 B 写入，assist 会话页读后即删） */
export const ASSIST_DRAFT_STORAGE_KEY = "donger.assistDraft";

const NONE_MARKER = "🤷 暂无能处理该任务的智能体";

/** 最近一条助手消息命中 none 标记 → 返回预填文本（原任务=最近一条用户消息）；否则 null */
export function noneAssistHint(messages: readonly ChatMessage[]): string | null {
  const reversed = [...messages].reverse();
  const lastAssistant = reversed.find((m) => m.role === "assistant");
  if (!lastAssistant?.text.startsWith(NONE_MARKER)) return null;
  const lastUser = reversed.find((m) => m.role === "user");
  if (!lastUser) return null;
  return `我想完成：${lastUser.text}。请协助创建能处理该任务的 agent 与 skills。`;
}
