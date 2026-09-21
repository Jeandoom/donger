import { GateRouter } from "../domain/gate-router.js";

/** 默认审批门策略：高危操作（部署/发布/推送）→ deploy 门。 */
// 三道门均为 force 门：full_access 权限模式不豁免（admin 高权限会话仍须人工确认外发写；
// 自我迭代智能体的安全前提，specs/2026-09-17-agent-self-deploy-design.md §3.6）。
export function createDefaultGates(): GateRouter {
  const gates = new GateRouter();
  gates.describe({ id: "deploy", description: "部署/发布/推送操作审批" });
  // release 用负向断言：release-202608-1 这类分支名/版本号是普通参数，不算发布动作
  //（此前误拦只读 git fetch origin release-202608-1，60s 审批超时致任务失败，复盘 P2-9）
  // deploy/publish/release 同样排除前置 `.`：`.deploy` 是部署目录名（生产工作区路径
  // 天然含 D:\...\.deploy\...），cd/python 等普通命令照抄附件绝对路径即被误拦、
  // 审批卡在手机端未处理便无限挂起（2026-09-21 个人财物管家两条会话卡死复盘）。
  // ./deploy.sh 前置是 / 不受负向断言影响，仍照拦。
  gates.add({
    gateId: "deploy",
    toolName: "Bash",
    commandPattern: /(?<!\.)\b(?:deploy|publish)\b|\bgit\s+push\b|(?<!\.)\brelease(?![-\w])/i,
    force: true,
  });
  // AI 生成子模块：平台工具写操作确认（SDK 中工具全名 = mcp__donger-platform__<tool>）
  gates.describe({ id: "authoring", description: "智能体/技能写入确认" });
  for (const t of ["create_agent", "update_agent", "write_skill", "update_skill"]) {
    gates.add({ gateId: "authoring", toolName: `mcp__donger-platform__${t}`, force: true });
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
    gates.add({ gateId: "git-write", toolName: `mcp__donger-git__${t}`, force: true });
  }
  return gates;
}
