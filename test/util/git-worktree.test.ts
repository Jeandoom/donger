import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree, removeWorktree } from "../../src/util/git-worktree.js";

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wt-repo-"));
  execSync(
    "git init -q && git config user.email t@t && git config user.name t && echo hi > a && git add . && git commit -qm init",
    { cwd: repo },
  );
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function branchExists(r: string, branch: string): boolean {
  try {
    execSync(`git -C "${r}" rev-parse --verify "${branch}"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("git-worktree", () => {
  it("createWorktree：建独立目录 + 新分支，文件已检出", () => {
    const wt = createWorktree(repo, "feat-x");
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(wt, "a"))).toBe(true);
    expect(branchExists(repo, "feat-x")).toBe(true);
  });

  it("removeWorktree：移除目录 + 删分支", () => {
    const wt = createWorktree(repo, "feat-y");
    removeWorktree(repo, "feat-y");
    expect(existsSync(wt)).toBe(false);
    expect(branchExists(repo, "feat-y")).toBe(false);
  });

  it("多个 worktree 互不干扰", () => {
    const a = createWorktree(repo, "feat-a");
    const b = createWorktree(repo, "feat-b");
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
    expect(branchExists(repo, "feat-a")).toBe(true);
    expect(branchExists(repo, "feat-b")).toBe(true);
  });
});
