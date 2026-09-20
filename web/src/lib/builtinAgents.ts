import type { AgentListDTO } from "./agents";
import { BUILTIN_ASSIST_AGENT_ID } from "./assist";

/** 内置技能工坊 ID（与后端 src/orchestrator/skill-forge-agent.ts 保持一致） */
export const BUILTIN_SKILL_FORGE_AGENT_ID = "builtin-skill-forge";

/** 全部内置智能体 id（与后端各 *-agent.ts 保持一致；不入库，仅前端合成条目） */
export const BUILTIN_AGENT_IDS: readonly string[] = [
  BUILTIN_ASSIST_AGENT_ID,
  BUILTIN_SKILL_FORGE_AGENT_ID,
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
    llm: {},
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
    llm: {},
    createdAt: "",
    updatedAt: "",
  },
];
