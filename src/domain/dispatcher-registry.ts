import type { Agent } from "./agent.js";
import { migrateTaskTypes, SCENARIO_PRESETS } from "./scenario-preset.js";

/** 表格单元格消毒：竖线/换行会破坏 markdown 行结构，统一替换 */
function sanitizeCell(text: string): string {
  return text.replace(/\|/g, "／").replace(/\r?\n/g, " ").trim();
}

/** 登记表「适用任务类型」列：scenario 受控词表优先，未标注的按名称+描述 best-effort 推断 */
function renderTaskTypes(agent: Agent): string {
  if (agent.scenario) {
    return `${SCENARIO_PRESETS[agent.scenario].name}（${agent.scenario}）`;
  }
  const inferred = migrateTaskTypes(`${agent.name} ${agent.description ?? ""}`);
  return inferred.length > 0 ? inferred.join("、") : "未标注";
}

/**
 * 纯函数：把用户可见的 agent 集合渲染为 dispatcher 登记表 markdown。
 * 事实源是 agents 表，每次分发实时渲染（无静态文件、无缓存）；空集合返回仅含表头的空表，
 * 由调用方（dispatch-flow）补充「暂无可用智能体」提示。
 * kbNames：知识库 id → 名称（渲染「业务知识库」列；缺省回退扩展目录名，未传时显示 kbId）。
 */
export function renderAgentRegistry(agents: Agent[], kbNames?: Map<string, string>): string {
  const header = [
    "| agentId | 名称 | 职责 | skills | 适用任务类型 | 业务知识库 |",
    "|---|---|---|---|---|---|",
  ];
  const rows = agents.map((agent) => {
    const duty = agent.description ? sanitizeCell(agent.description) : "（未填写）";
    const skills = agent.skills.length > 0 ? agent.skills.map(sanitizeCell).join(" / ") : "无";
    const kb =
      agent.knowledgeBaseIds && agent.knowledgeBaseIds.length > 0
        ? agent.knowledgeBaseIds
            .map((id) => kbNames?.get(id) ?? id.slice(0, 8))
            .map(sanitizeCell)
            .join(" / ")
        : agent.extensionDirectories.length > 0
          ? agent.extensionDirectories.map((d) => sanitizeCell(d.name)).join(" / ")
          : "无";
    return `| ${sanitizeCell(agent.id)} | ${sanitizeCell(agent.name)} | ${duty} | ${skills} | ${renderTaskTypes(agent)} | ${kb} |`;
  });
  return [...header, ...rows].join("\n");
}
