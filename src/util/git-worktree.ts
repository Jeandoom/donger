import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

/** 在 repoRoot/.worktrees/<branch> 创建基于 base（默认 HEAD）的新分支 worktree，返回其绝对路径。 */
export function createWorktree(repoRoot: string, branch: string, base = "HEAD"): string {
  const root = resolve(repoRoot);
  const wt = join(root, ".worktrees", branch);
  // 参数数组直传 git，不经 shell（branch/base 来自外部输入，杜绝注入面）
  execFileSync("git", ["-C", root, "worktree", "add", "-b", branch, wt, base], {
    stdio: "pipe",
  });
  return wt;
}

/** 移除 worktree 并删除其分支。 */
export function removeWorktree(repoRoot: string, branch: string): void {
  const root = resolve(repoRoot);
  const wt = join(root, ".worktrees", branch);
  execFileSync("git", ["-C", root, "worktree", "remove", "--force", wt], { stdio: "pipe" });
  execFileSync("git", ["-C", root, "branch", "-D", branch], { stdio: "pipe" });
}
