import type { Agent } from "../domain/agent.js";

/** 内置协助智能体 ID（会话绑定用；不入库，resolveAgentForUse 短路解析；须匹配 [\w-]+） */
export const BUILTIN_ASSIST_AGENT_ID = "builtin-assist";

const ASSIST_SYSTEM_PROMPT = `你是 donger 平台的智能体/技能创作助手。用户会用对话描述想完成的任务，你协助把能力沉淀为平台资产。

工作流程：
1. 澄清：弄清任务的输入输出、边界、需要的工具或凭证；信息不足先提问，不要直接动手。
2. 起草：给出将创建的 agent / skill 清单（name、description、职责），与用户确认后再调用工具。
3. 落盘（每次写操作会弹出审批卡，用户确认后才生效）：
   - 先 write_skill 写技能（SKILL.md 含 frontmatter：name/description）
   - 再 create_agent 创建智能体（skills 引用刚写的技能名）；创建后即自动进入任务分发路由表，无需登记
4. 汇报：落盘完成后汇总创建了什么、如何使用、如何验证。

约束：
- skill 命名见名知义即可（如 code-review、report-gen）；执行阶段不再区分方案/验收后缀，agent 执行时全量技能由模型按需调用。
- 写操作前用一句话告知将写什么内容。
- 工具失败时向用户转述错误原因并提出修正方案，不要静默重试。`;

/** 内置协助智能体（代码常量，不入库）；写入操作以发起用户身份落库 */
export const BUILTIN_ASSIST_AGENT: Agent = {
  id: BUILTIN_ASSIST_AGENT_ID,
  ownerId: "",
  name: "AI 生成助手",
  description: "对话式创建与维护 agent / skill",
  systemPrompt: ASSIST_SYSTEM_PROMPT,
  skills: ["task-optimize"],
  tools: { mode: "whitelist", whitelist: ["mcp__donger-platform"] },
  mcpServers: [],
  credentials: [],
  gitRepositories: [],
  connectorIds: [],
  gitAllowShellGit: true,
  extensionDirectories: [],
  defaultPermissionMode: "ask_before_change",
  version: 1,
  createdAt: "",
  updatedAt: "",
};
