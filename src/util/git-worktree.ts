import { execSync } from "node:child_process";
import { join } from "node:path";

/** 在 repoRoot/.worktrees/<branch> 创建基于 base（默认 HEAD）的新分支 worktree，返回其路径。 */
export function createWorktree(repoRoot: string, branch: string, base = "HEAD"): string {
  const wt = join(repoRoot, ".worktrees", branch);
  execSync(`git -C "${repoRoot}" worktree add -b "${branch}" "${wt}" "${base}"`, {
    stdio: "pipe",
  });
  return wt;
}

/** 移除 worktree 并删除其分支。 */
export function removeWorktree(repoRoot: string, branch: string): void {
  const wt = join(repoRoot, ".worktrees", branch);
  execSync(`git -C "${repoRoot}" worktree remove --force "${wt}"`, { stdio: "pipe" });
  execSync(`git -C "${repoRoot}" branch -D "${branch}"`, { stdio: "pipe" });
}
