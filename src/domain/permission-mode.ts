import { z } from "zod";

/**
 * 会话权限模式（工具审批门的执行策略）：
 * - ask_before_change：命中审批门的工具调用推审批卡等人工决议（历史默认行为）；
 * - full_access：命中审批门的工具调用直接放行。
 * 两种模式都不绕过：工具白名单、写入边界、shell git 守卫——这三者是安全不变量。
 */
export const AGENT_PERMISSION_MODES = ["ask_before_change", "full_access"] as const;
export const AgentPermissionModeSchema = z.enum(AGENT_PERMISSION_MODES);
export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number];

/** 系统缺省模式：变更前问询 */
export const DEFAULT_PERMISSION_MODE: AgentPermissionMode = "ask_before_change";

/**
 * 生效模式解析：会话覆盖 > 智能体默认 > 系统缺省。
 * 会话存储值为空表示「跟随智能体默认」——智能体改配置后存量会话自动跟随。
 */
export function resolvePermissionMode(
  conversationMode?: AgentPermissionMode,
  agentMode?: AgentPermissionMode,
): AgentPermissionMode {
  return conversationMode ?? agentMode ?? DEFAULT_PERMISSION_MODE;
}

/** 无人值守（定时/钩子/工作流触发）强制按变更前问询执行，full_access 仅限交互式会话。 */
export function resolveUnattendedPermissionMode(): AgentPermissionMode {
  return DEFAULT_PERMISSION_MODE;
}
