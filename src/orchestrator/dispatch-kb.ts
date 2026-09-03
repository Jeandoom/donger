import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const AGENTS_MD = `# 执行智能体登记表

> dispatcher 据此选择执行智能体。新增智能体 = 在此表加一行 + 为其配 skills；平台代码零改动。

| agentId | 名称 | 职责 | skills | 适用任务类型 | 业务知识库 |
|---|---|---|---|---|---|
| （示例）agent-dev-web | web 开发 | donger 前端 web/ 子包开发 | web-design / web-execute / web-accept | 前端需求、bug 修复 | 无 |
| （示例）agent-ops | 运维 | apollo / SLS / langfuse / db 巡检、部署 | ops-execute / ops-accept | 配置变更、巡检、部署 | kb/agent-ops/ |

<!-- 在上方追加真实登记行；删除示例行前先确保已有真实行 -->
`;

const ROUTING_RULES_MD = `# 路由规则

1. **唯一路由**：从登记表选定恰好一个 agentId；表中无匹配时 agentId 填 \`none\`，并在 rationale 说明能力缺口（不要猜一个近似 id）。
2. **requiresDesign 判定**：涉及代码实现 / 架构变更 / 陌生业务背景 → \`true\`；查询、巡检、信息整理、明确的小改动 → \`false\`。
3. **taskType**：自由分类标签（如 \`dev-bugfix\` / \`dev-feature\` / \`ops-inspect\` / \`ops-deploy\` / \`doc\`），保持同一类任务用同一标签，便于统计。
4. **rationale**：一句话说明为什么路由到该智能体，会展示给用户并用于后续优化。
`;

/** 幂等 seed 任务管理知识库；已存在的文件不覆盖（保留人工/优化产物的修改）。 */
export function ensureDispatcherKb(kbDir: string): void {
  const dir = join(kbDir, "dispatcher");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of [
    ["agents.md", AGENTS_MD],
    ["routing-rules.md", ROUTING_RULES_MD],
  ] as const) {
    const p = join(dir, name);
    if (!existsSync(p)) writeFileSync(p, content, "utf8");
  }
}
