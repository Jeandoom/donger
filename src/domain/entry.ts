import type { Conversation } from "./conversation.js";

/** agent 链配置：task-flow 各环节可替换为用户自建 agent（缺省用系统内置常量） */
export interface AgentChainConfig {
  /** 路由环节（缺省 builtin-dispatcher） */
  dispatcherAgentId?: string;
  /** 补建环节（缺省 builtin-builder） */
  builderAgentId?: string;
  /** 闲聊兜底环节（缺省 builtin-chat） */
  chatAgentId?: string;
}

/** 会话入口：显式绑定 agent 直连，否则走默认 task-flow 编排 */
export type Entry =
  | { flow: "direct"; agentId: string }
  | {
      flow: "task-flow";
      dispatcherAgentId?: string;
      builderAgentId?: string;
      chatAgentId?: string;
    };

/**
 * 解析会话入口（统一对话入口模型）：
 * - 会话绑定了 agent（用户 /agent 显式选择）→ direct：请求直连该 agent，旁路路由；
 * - 未绑定 → task-flow：dispatcher 路由 → biz agent 执行 | builder 补建 | chat 兜底。
 * 入口与 agent 解耦：agent 链每环可经配置替换，默认系统内置。
 */
export function resolveEntry(
  conversation: Pick<Conversation, "agentId">,
  chain: AgentChainConfig = {},
): Entry {
  if (conversation.agentId) return { flow: "direct", agentId: conversation.agentId };
  return {
    flow: "task-flow",
    dispatcherAgentId: chain.dispatcherAgentId,
    builderAgentId: chain.builderAgentId,
    chatAgentId: chain.chatAgentId,
  };
}
