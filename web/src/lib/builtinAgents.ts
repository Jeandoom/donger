import type { AgentListDTO } from "./agents";
import { BUILTIN_ASSIST_AGENT_ID } from "./assist";

/** 内置技能工坊 ID（与后端 src/orchestrator/skill-forge-agent.ts 保持一致） */
export const BUILTIN_SKILL_FORGE_AGENT_ID = "builtin-skill-forge";

/** 内置会话审计师 ID（与后端 src/orchestrator/auditor-agent.ts 保持一致） */
export const BUILTIN_AUDITOR_AGENT_ID = "builtin-auditor";

/** 内置平台进化官 ID（与后端 src/orchestrator/self-improver-agent.ts 保持一致）；仅管理员可见 */
export const BUILTIN_SELF_IMPROVER_AGENT_ID = "builtin-self-improver";

/** 内置知识库管家 ID（与后端 src/orchestrator/kb-assistant-agent.ts 保持一致）；
 *  KB 会话专属（从侧栏「知识库」分组进入），不进「内置智能体」合成条目 */
export const BUILTIN_KB_ASSISTANT_ID = "builtin-kb-assistant";

/** 内置应用管家 ID（与后端 src/orchestrator/app-manager-agent.ts 保持一致）；应用闭环专职 */
export const BUILTIN_APP_MANAGER_ID = "builtin-app-manager";

/** 全部内置智能体 id（与后端各 *-agent.ts 保持一致；不入库，仅前端合成条目） */
export const BUILTIN_AGENT_IDS: readonly string[] = [
  BUILTIN_ASSIST_AGENT_ID,
  BUILTIN_SKILL_FORGE_AGENT_ID,
  BUILTIN_AUDITOR_AGENT_ID,
  BUILTIN_SELF_IMPROVER_AGENT_ID,
  BUILTIN_APP_MANAGER_ID,
];

export function isBuiltinAgentId(id: string | undefined | null): boolean {
  return id != null && BUILTIN_AGENT_IDS.includes(id);
}

/** 内置智能体的合成侧栏条目（不入库，前端常量；固定置底，不参与星标/拖拽） */
export const BUILTIN_AGENT_ENTRIES: AgentListDTO[] = [
  {
    id: BUILTIN_ASSIST_AGENT_ID,
    ownerId: "",
    _mine: true,
    name: "AI 生成助手",
    description: "对话式创建 agent / skill",
    skills: [],
    tools: { mode: "whitelist", whitelist: [] },
    mcpServers: [],
    createdAt: "",
    updatedAt: "",
  },
  {
    id: BUILTIN_SKILL_FORGE_AGENT_ID,
    ownerId: "",
    _mine: true,
    name: "技能工坊",
    description: "对话式创建与优化升级平台技能（SKILL.md）",
    skills: [],
    tools: { mode: "whitelist", whitelist: [] },
    mcpServers: [],
    createdAt: "",
    updatedAt: "",
  },
  {
    id: BUILTIN_AUDITOR_AGENT_ID,
    ownerId: "",
    _mine: true,
    name: "会话审计师",
    description: "对话式分析历史会话（数据可见性按发起用户权限收口）",
    skills: [],
    tools: { mode: "whitelist", whitelist: [] },
    mcpServers: [],
    createdAt: "",
    updatedAt: "",
  },
  {
    id: BUILTIN_SELF_IMPROVER_AGENT_ID,
    ownerId: "",
    _mine: true,
    name: "平台进化官",
    description: "改进意见 → 评估 → 设计 → 实现 → MR（仅管理员；合并与部署人工）",
    skills: [],
    tools: { mode: "whitelist", whitelist: [] },
    mcpServers: [],
    createdAt: "",
    updatedAt: "",
  },
  {
    id: BUILTIN_APP_MANAGER_ID,
    ownerId: "",
    _mine: true,
    name: "应用管家",
    description: "对话式开发、发布、迭代、备份平台应用",
    skills: [],
    tools: { mode: "whitelist", whitelist: [] },
    mcpServers: [],
    createdAt: "",
    updatedAt: "",
  },
];
