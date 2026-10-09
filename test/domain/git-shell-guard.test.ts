import { describe, expect, it } from "vitest";
import type { GateRouter } from "../../src/domain/gate-router.js";
import { matchesShellGit, matchUnsafeShellGit } from "../../src/domain/git-shell-guard.js";
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

// 2026-10-09 拍板④：shell git 默认放开的前提约束——鉴权必须 https+平台系统凭证。
// 系统级不可用形态在任何配置（含 gitAllowShellGit=true）下恒拒。
describe("matchUnsafeShellGit（系统级恒拒形态）", () => {
  it("credential：宿主凭证栈直读全形态命中（含 python subprocess 列表形态）", () => {
    for (const cmd of [
      "git credential fill",
      'python -c "subprocess.run([\\"git\\",\\"credential\\",\\"fill\\"])"',
      'python - << \'EOF\'\nsubprocess.run(["git", "credential", "fill"])',
      "git -c x=y credential approve",
      "git config credential.helper '!f'",
    ]) {
      expect(matchUnsafeShellGit(cmd), cmd).toContain("credential");
    }
    // 文件名/普通词不误伤
    expect(matchUnsafeShellGit("cat docs/git-credential-guide.md")).toBeNull();
    expect(matchUnsafeShellGit('git commit -m "fix credential bug"')).toBeNull();
  });

  it("config --global/--system：宿主 git 配置写入命中；仓库级 config 不拦", () => {
    expect(matchUnsafeShellGit("git config --global user.name a")).toContain("config");
    expect(matchUnsafeShellGit("git --git-dir x config --system core.fsmonitor '!cmd'")).toContain(
      "config",
    );
    expect(matchUnsafeShellGit("git config user.name a")).toBeNull();
  });

  it("非 https 远程：scp 形/ssh://、git://、http:// 命中；https 放行", () => {
    expect(matchUnsafeShellGit("git clone git@gitee.com:renkee/copilot-skills.git")).toContain(
      "非 https",
    );
    expect(matchUnsafeShellGit("git ls-remote ssh://git@gitee.com/x.git")).toContain("非 https");
    expect(matchUnsafeShellGit("git clone http://gitee.com/x.git")).toContain("非 https");
    expect(
      matchUnsafeShellGit("git ls-remote https://gitee.com/renkee/copilot-skills.git HEAD"),
    ).toBeNull();
  });

  it("拍板④回归锚点：本地/https 形态不再拦（默认放开，push 走 deploy force 门）", () => {
    // c385dc71 生产会话 2026-10-09 实际执行的两条命令
    expect(matchUnsafeShellGit("cd /d/git/copilot-skills && git pull --ff-only")).toBeNull();
    expect(matchUnsafeShellGit("git log --oneline -1; git config user.name")).toBeNull();
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
