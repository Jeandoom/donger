/**
 * 已退役内置智能体（2026-11-04 拍板全量下架：builtin 路由链/创作助手/审计师/KB 管家等
 * 角色已被平台能力吸收）。id → 中文名。
 * 消费点：resolveAgentForUse 命中报「已下架」而非裸 404；会话列表过滤隐藏（web-channel）；
 * 数据保留不删。
 */
export const RETIRED_BUILTIN_AGENTS: Record<string, string> = {
  "builtin-assist": "AI 生成助手",
  "agent-builder": "Agent Builder",
  "builtin-skill-forge": "技能工坊",
  "builtin-auditor": "会话审计师",
  "builtin-self-improver": "平台进化官",
  "builtin-auto-fix": "自动修复工程师",
  "builtin-kb-assistant": "知识库管家",
  "builtin-chat": "系统对话助手",
  "builtin-dispatcher": "任务分发器",
};

export function isRetiredBuiltinAgentId(agentId: string | undefined | null): boolean {
  return agentId != null && agentId in RETIRED_BUILTIN_AGENTS;
}
