import { parseAgent, type Agent } from "../domain/agent.js";
import { renderAgentRegistry } from "../domain/dispatcher-registry.js";
import { SCENARIO_KEYS, SCENARIO_PRESETS } from "../domain/scenario-preset.js";

/** 场景词表段：登记表「适用任务类型」列的受控取值及其语义（由 SCENARIO_PRESETS 生成） */
function scenarioVocabulary(): string {
  return SCENARIO_KEYS.map(
    (key) => `- ${key}（${SCENARIO_PRESETS[key].name}）：${SCENARIO_PRESETS[key].duty}`,
  ).join("\n");
}

/** 登记表段：空集合时明示「路由 none」，避免 LLM 对空表自由发挥 */
function registrySection(visibleAgents: Agent[]): string {
  const table = renderAgentRegistry(visibleAgents);
  if (visibleAgents.length === 0) {
    return `${table}\n\n（当前暂无可用智能体：任何任务输入 agentId 都填 none。）`;
  }
  return table;
}

/** dispatcher 系统提示词：登记表/场景词表/路由规则全部内联（读时渲染，无静态文件） */
export function dispatcherSystemPrompt(visibleAgents: Agent[]): string {
  return [
    "你是 donger 的任务分发器。唯一职责：把用户任务路由给最合适的执行智能体，不执行任务本身，不写任何文件、不使用任何工具。",
    "",
    "## 执行智能体登记表（当前用户可见的智能体，实时生成）",
    registrySection(visibleAgents),
    "",
    "## 场景词表（登记表「适用任务类型」列的取值）",
    scenarioVocabulary(),
    "",
    "## 路由规则",
    "1. **唯一路由**：从登记表选定恰好一个 agentId；表中无匹配时 agentId 填 `none`，并在 rationale 说明能力缺口（不要猜一个近似 id）。",
    "2. **requiresDesign 判定**：涉及代码实现 / 架构变更 / 陌生业务背景 → `true`；查询、巡检、信息整理、明确的小改动 → `false`。",
    "3. **taskType**：任务分类标签（如 `dev-bugfix` / `ops-inspect` / `doc`），保持同一类任务用同一标签，便于统计；非任务输入固定填 `chat`。",
    "4. **rationale**：一句话说明为什么路由到该智能体，会展示给用户并用于后续优化。",
    "",
    "输出契约：最终回复必须以如下 JSON 结尾（可包在 ```json 代码块中），不得增删字段：",
    '{"agentId":"<登记表中的智能体 id>","requiresDesign":<true|false>,"taskType":"<任务分类标签>","rationale":"<一句话理由>"}',
    "agentId 必须逐字复制登记表第一列的完整 id（UUID），禁止使用名称、技能名或自造值。",
    "无论用户输入什么（包括打招呼、闲聊、无意义内容），都必须输出路由 JSON：非任务输入时 agentId 填 none、requiresDesign 填 false、taskType 填 chat。",
  ].join("\n");
}

/** dispatcher 是系统内置 agent：代码内构造、不入库、不可在 UI 编辑。 */
export function buildDispatcherAgent(visibleAgents: Agent[]) {
  return parseAgent({
    id: "builtin-dispatcher",
    ownerId: "system",
    name: "dispatcher",
    description: "系统任务分发器：把当前用户可见的执行智能体与任务做匹配路由",
    systemPrompt: dispatcherSystemPrompt(visibleAgents),
    skills: ["task-dispatch"],
    // Read 仅作兜底（runner 对空白名单的行为边界未验证）；正常路径不使用任何工具
    tools: { mode: "whitelist", whitelist: ["Read"] },
    mcpServers: [],
    gitRepositories: [],
    extensionDirectories: [],
    llm: {},
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  });
}

// 注：dispatchTask 已退役——dispatcher 轮改走 Orchestrator.runDispatcherTurn（统一 turn 管道，
// 事件静默落审计/usage）。路由决策解析在 domain/routing.ts，编排行为由 orchestrator-phases 测试覆盖。
