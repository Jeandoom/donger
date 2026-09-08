import { join } from "node:path";
import { parseAgent } from "../domain/agent.js";

/** dispatcher 系统提示词（kbPath 注入绝对路径，避免模型全盘搜索知识库浪费数十秒） */
function dispatcherSystemPrompt(kbPath: string): string {
  return [
    "你是 donger 的任务分发器。唯一职责：把用户任务路由给最合适的执行智能体，不执行任务本身，不写任何文件。",
    `步骤：直接用 Read 工具读取以下两个知识库文件（路径已给出，禁止全盘 Glob/find 搜索）：`,
    `1. ${join(kbPath, "agents.md")}（执行智能体登记表）`,
    `2. ${join(kbPath, "routing-rules.md")}（路由规则）`,
    "对照用户任务选定唯一 agentId，并判定该任务是否需要方案设计人工确认（requiresDesign：涉及代码实现/架构变更/不熟悉的业务为 true；查询巡检/信息整理类为 false）。",
    "agentId 必须逐字复制登记表第一列的完整 id（UUID），禁止使用名称、技能名或自造值。",
    "输出契约：最终回复必须以如下 JSON 结尾（可包在 ```json 代码块中），不得增删字段：",
    '{"agentId":"<登记表中的智能体 id>","requiresDesign":<true|false>,"taskType":"<任务分类标签>","rationale":"<一句话理由>"}',
    '知识库中无合适智能体时，agentId 填 "none" 并在 rationale 中说明能力缺口。',
    "无论用户输入什么（包括打招呼、闲聊、无意义内容），都必须输出路由 JSON：非任务输入时 agentId 填 none、requiresDesign 填 false、taskType 填 chat。",
  ].join("\n");
}

/** dispatcher 是系统内置 agent：代码内构造、不入库、不可在 UI 编辑（plan 偏差 1）。 */
export function buildDispatcherAgent(kbDir: string) {
  const kbPath = join(kbDir, "dispatcher");
  return parseAgent({
    id: "builtin-dispatcher",
    ownerId: "system",
    name: "dispatcher",
    description: "系统任务分发器：阅读任务管理知识库，把任务路由给执行智能体",
    systemPrompt: dispatcherSystemPrompt(kbPath),
    skills: ["task-dispatch"],
    tools: { mode: "whitelist", whitelist: ["Read", "Glob"] },
    mcpServers: [],
    gitRepositories: [],
    extensionDirectories: [
      {
        id: "kb-dispatcher",
        name: "任务管理知识库",
        path: kbPath,
        access: "readOnly",
      },
    ],
    llm: {},
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  });
}

// 注：dispatchTask 已退役——dispatcher 轮改走 Orchestrator.runDispatcherTurn（统一 turn 管道，
// 事件静默落审计/usage）。路由决策解析在 domain/routing.ts，编排行为由 orchestrator-phases 测试覆盖。
