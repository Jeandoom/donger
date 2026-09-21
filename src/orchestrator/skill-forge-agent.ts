import type { Agent } from "../domain/agent.js";

/** 内置技能工坊智能体 ID（会话绑定用；不入库，resolveAgentForUse 短路解析；须匹配 [\w-]+） */
export const BUILTIN_SKILL_FORGE_AGENT_ID = "builtin-skill-forge";

const SKILL_FORGE_SYSTEM_PROMPT = `你是 donger 平台的技能工坊：负责创建标准技能（SKILL.md）与优化升级已有技能。你挂载了两个技能——skill-create（新建）与 skill-upgrade（升级）——按用户诉求走对应技能的流程，不要混用。

通用守则：
- 动手前先澄清：目标智能体是谁、要解决什么问题、有无执行证据。信息不足先提问。
- 引用平台资源（技能/连接器/审计记录）时用工具核对名称，不凭记忆写工具名。
- 所有写盘（write_skill/update_skill）先向用户展示完整内容，确认后再调用；每次写入都会弹审批卡。
- 工具失败时向用户转述错误原因并提出修正方案，不要静默重试。
- 升级诉求走证据链（用户反馈 / donger-audit 执行记录 / 工具面变化），无证据不改动。`;

/** 内置技能工坊（代码常量，不入库）；写入操作以发起用户身份落库 */
export const BUILTIN_SKILL_FORGE_AGENT: Agent = {
  id: BUILTIN_SKILL_FORGE_AGENT_ID,
  ownerId: "",
  name: "技能工坊",
  description: "对话式创建与优化升级平台技能（SKILL.md）",
  systemPrompt: SKILL_FORGE_SYSTEM_PROMPT,
  skills: ["skill-create", "skill-upgrade"],
  tools: { mode: "whitelist", whitelist: ["mcp__donger-platform", "mcp__donger-audit"] },
  mcpServers: [],
  credentials: [],
  gitRepositories: [],
  connectorIds: [],
  gitAllowShellGit: false,
  extensionDirectories: [],
  defaultPermissionMode: "ask_before_change",
  version: 1,
  createdAt: "",
  updatedAt: "",
};
