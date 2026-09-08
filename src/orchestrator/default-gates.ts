import { GateRouter } from "../domain/gate-router.js";

/** 默认审批门策略：高危操作（部署/发布/推送）→ deploy 门。 */
export function createDefaultGates(): GateRouter {
  const gates = new GateRouter();
  gates.describe({ id: "deploy", description: "部署/发布/推送操作审批" });
  gates.add({
    gateId: "deploy",
    toolName: "Bash",
    commandPattern: /\b(deploy|publish|release|git\s+push)\b/i,
  });
  // 阶段门（P2 三段式）：仅元数据，无工具规则——由编排层在阶段边界直调 channel.requestApproval
  gates.describe({ id: "design", description: "方案设计确认" });
  gates.describe({ id: "acceptance", description: "验收确认" });
  // AI 生成子模块：平台工具写操作确认（SDK 中工具全名 = mcp__donger-platform__<tool>）
  gates.describe({ id: "authoring", description: "智能体/技能写入确认" });
  for (const t of ["create_agent", "update_agent", "write_skill"]) {
    gates.add({ gateId: "authoring", toolName: `mcp__donger-platform__${t}` });
  }
  return gates;
}
