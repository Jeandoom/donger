import { z } from "zod";

/**
 * 会话权限模式（工具审批门的执行策略）：
 * - ask_before_change：命中审批门的工具调用推审批卡等人工决议（历史默认行为）；
 * - risk_guard（风险拦截）：常规审批门放行，风险不变量仍弹卡（解码管线 INV-6/10、
 *   渗出闸 INV-8、bashAllowlist、force 门）；即 2026-10-13 之前的 full_access 语义；
 * - full_access（完全权限，零审批拦截）：全部审批类门（常规+INV+force）直接放行，
 *   INV 命中落 inv_bypass 审计打标。
 * 三种模式都不绕过 deny 级静态守卫：工具白名单、写入边界、shell git、要害路径读、
 * 启动敏感文件、env 脱敏、敏感读扫描——守卫是直接拒绝（不弹卡），模式无法豁免。
 */
export const AGENT_PERMISSION_MODES = ["ask_before_change", "risk_guard", "full_access"] as const;
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

/** 无人值守缺省模式（定时/钩子等未携带消息级模式的触发）：强制按变更前问询执行。
 *  工作流触发不走此缺省——以工作流配置的 permissionMode 为准（2026-10-14 拍板）。 */
export function resolveUnattendedPermissionMode(): AgentPermissionMode {
  return DEFAULT_PERMISSION_MODE;
}

/** 轮级生效模式：消息级覆盖（工作流派发携带配置值）> 无人值守缺省（变更前问询）
 *  > 会话覆盖 > 智能体默认 > 系统缺省。 */
export function resolveTurnPermissionMode(p: {
  messageMode?: AgentPermissionMode;
  unattended: boolean;
  conversationMode?: AgentPermissionMode;
  agentMode?: AgentPermissionMode;
}): AgentPermissionMode {
  if (p.messageMode) return p.messageMode;
  return resolvePermissionMode(
    p.unattended ? DEFAULT_PERMISSION_MODE : p.conversationMode,
    p.agentMode,
  );
}
