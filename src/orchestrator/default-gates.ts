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
  return gates;
}
