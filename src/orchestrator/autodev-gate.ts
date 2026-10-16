/**
 * autoDev git-write 门放行判定（spec 2026-10-16-feedback-auto-dev-deploy-l2-design §4.4）。
 * 纯函数：无人值守 autoDev 轮内，绑定仓库上的限定形态 git 写操作由策略放行
 * （不弹审批卡）；其余任何形态照旧走门（L1 兜底）。放行面刻意收窄：
 * - 仓库必须等于 workflow 绑定 agent 的首仓库；
 * - git_push/git_create_branch：分支名 fix-YYYYMMDD-* / feat-YYYYMMDD-*，且禁止 force push；
 * - git_create_mr：目标分支 master、标题 [autofix] 前缀；
 * - git_merge_mr 永不在放行面（合并是 ReleaseService 的服务端职责）。
 * kill-switch（DONGER_AUTODEV_DISABLED）开启时全部不放行。
 */
export const AUTOFIX_TITLE_PREFIX = "[autofix]";
export const AUTOFIX_BRANCH_RE = /^(?:feat|fix)-\d{8}-[\w.-]+$/;

const GIT_PUSH = "mcp__donger-git__git_push";
const GIT_CREATE_BRANCH = "mcp__donger-git__git_create_branch";
const GIT_CREATE_MR = "mcp__donger-git__git_create_mr";

export interface AutoDevGateContext {
  /** workflow 绑定 agent 的首仓库名（gitRepositories[0].name） */
  repositoryName: string;
  /** kill-switch 现取（config.autodevDisabled） */
  disabled: () => boolean;
}

export function autoDevGitAllowCheck(
  ctx: AutoDevGateContext,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (ctx.disabled()) return false;
  const repoName = typeof input.repoName === "string" ? input.repoName : "";
  if (!repoName || repoName !== ctx.repositoryName) return false;
  switch (toolName) {
    case GIT_PUSH:
    case GIT_CREATE_BRANCH: {
      if (input.force === true) return false;
      const branch = typeof input.branch === "string" ? input.branch : "";
      return AUTOFIX_BRANCH_RE.test(branch);
    }
    case GIT_CREATE_MR: {
      const source = typeof input.source === "string" ? input.source : "";
      const target = typeof input.target === "string" ? input.target : "";
      const title = typeof input.title === "string" ? input.title : "";
      return (
        AUTOFIX_BRANCH_RE.test(source) && target === "master" && title.startsWith(AUTOFIX_TITLE_PREFIX)
      );
    }
    default:
      return false;
  }
}
