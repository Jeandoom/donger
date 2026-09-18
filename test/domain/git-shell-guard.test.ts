import { describe, expect, it } from "vitest";
import type { GateRouter } from "../../src/domain/gate-router.js";
import { matchesShellGit } from "../../src/domain/git-shell-guard.js";
import { createDefaultGates } from "../../src/orchestrator/default-gates.js";

describe("matchesShellGit（shell git 守卫纯函数）", () => {
  it("正例：常见 git 调用形态全部命中", () => {
    for (const cmd of [
      "git push origin main",
      "git clone https://github.com/a/b.git",
      "git.exe pull",
      "cd repo && git fetch --tags",
      "/usr/bin/git reset --hard",
      "git -C dir commit -m x",
      "echo start; git rebase main",
      "git ls-remote origin",
    ]) {
      expect(matchesShellGit(cmd), cmd).toBe(true);
    }
  });

  it("负例：非 git 调用不误伤", () => {
    for (const cmd of [
      "ls -la",
      "npm run build",
      "gitx push",
      "npx git-parse ./repo",
      "echo hello world",
      "cat README.md",
      "docker push registry/app:1.0",
      "node scripts/deploy.js",
      "cargo build --release",
      'echo "done: commit later"', // 无 git 二进制词
      "git", // 裸 git 词无子命令
    ]) {
      expect(matchesShellGit(cmd), cmd).toBe(false);
    }
  });
});

describe("default gates：git-write 审批门", () => {
  it("donger-git 外发写操作命中 git-write 门；只读与本地操作不设门", () => {
    const gates: GateRouter = createDefaultGates();
    for (const tool of [
      "mcp__donger-git__git_push",
      "mcp__donger-git__git_create_repo",
      "mcp__donger-git__git_create_branch",
      "mcp__donger-git__git_create_mr",
      "mcp__donger-git__git_merge_mr",
    ]) {
      const hit = gates.match(tool, { repoName: "demo" });
      expect(hit?.gateId, tool).toBe("git-write");
    }
    for (const tool of [
      "mcp__donger-git__git_clone",
      "mcp__donger-git__git_pull",
      "mcp__donger-git__git_commit",
      "mcp__donger-git__git_merge",
      "mcp__donger-git__git_status",
      "mcp__donger-git__git_platform_list_branches",
    ]) {
      expect(gates.match(tool, { repoName: "demo" })?.gateId, tool).toBeUndefined();
    }
  });
});
