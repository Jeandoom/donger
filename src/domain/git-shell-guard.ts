// shell git 命令守卫（收口防线 2，纯函数）：agent 会话默认禁止 Bash 直跑 git，
// 引导改用 donger-git 工具（git_clone/git_pull/git_push…）。逃生门：agent 配置
// gitAllowShellGit=true 时 runner 不再调用本守卫（push 仍走 deploy 审批门）。
// 边界如实声明：只能拦「命令文本里的 git 调用」，脚本内间接 spawn git 由
// 防线 1（token 不进 env）兜底，见 specs/2026-09-09-git-platform-tools-design.md §5。

/** git 二进制词法：独立词 git / git.exe（gitx、npx git-parse 等不命中） */
const GIT_BIN = /\bgit(\.exe)?\s/;
/** git 子命令词表：覆盖仓库操作全场景；多为常见英文词，与 GIT_BIN 双条件 AND 降低误伤 */
const GIT_SUBCOMMAND =
  /\b(clone|pull|push|fetch|merge|commit|checkout|branch|remote|rebase|reset|tag|ls-remote|stash|cherry-pick|revert|worktree|submodule|init)\b/;

export function matchesShellGit(command: string): boolean {
  return GIT_BIN.test(command) && GIT_SUBCOMMAND.test(command);
}
