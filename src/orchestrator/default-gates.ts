import { GateRouter } from "../domain/gate-router.js";

/** 默认审批门策略：高危操作（部署/发布/推送）→ deploy 门。 */
export function createDefaultGates(): GateRouter {
  const gates = new GateRouter();
  gates.describe({ id: "deploy", description: "部署/发布/推送操作审批" });
  // release 用负向断言：release-202608-1 这类分支名/版本号是普通参数，不算发布动作
  //（此前误拦只读 git fetch origin release-202608-1，60s 审批超时致任务失败，复盘 P2-9）
  gates.add({
    gateId: "deploy",
    toolName: "Bash",
    commandPattern: /\b(deploy|publish|git\s+push)\b|\brelease(?![-\w])/i,
  });
  // AI 生成子模块：平台工具写操作确认（SDK 中工具全名 = mcp__donger-platform__<tool>）
  gates.describe({ id: "authoring", description: "智能体/技能写入确认" });
  for (const t of ["create_agent", "update_agent", "write_skill", "update_skill"]) {
    gates.add({ gateId: "authoring", toolName: `mcp__donger-platform__${t}` });
  }
  // git 收口防线 3：donger-git 外发写操作人工确认（本地可撤销操作 commit/merge 不设门）
  gates.describe({ id: "git-write", description: "Git 写操作审批（push/建仓/建分支/MR/合并）" });
  for (const t of [
    "git_push",
    "git_create_repo",
    "git_create_branch",
    "git_create_mr",
    "git_merge_mr",
  ]) {
    gates.add({ gateId: "git-write", toolName: `mcp__donger-git__${t}` });
  }
  return gates;
}
