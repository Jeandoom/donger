import { describe, expect, it } from "vitest";
import { buildAutoFixAgent, BUILTIN_AUTO_FIX_AGENT_ID } from "../../src/orchestrator/auto-fix-agent.js";
import {
  autoDevGitAllowCheck,
  AUTOFIX_BRANCH_RE,
} from "../../src/orchestrator/autodev-gate.js";

const ctx = { repositoryName: "donger", disabled: () => false };

describe("autoDevGitAllowCheck", () => {
  it("git_push：合法分支放行，force/异仓库/异形分支拒绝", () => {
    expect(
      autoDevGitAllowCheck(ctx, "mcp__donger-git__git_push", {
        repoName: "donger",
        branch: "fix-20261017-export-field",
      }),
    ).toBe(true);
    expect(
      autoDevGitAllowCheck(ctx, "mcp__donger-git__git_push", {
        repoName: "donger",
        branch: "fix-20261017-x",
        force: true,
      }),
    ).toBe(false);
    expect(
      autoDevGitAllowCheck(ctx, "mcp__donger-git__git_push", {
        repoName: "other",
        branch: "fix-20261017-x",
      }),
    ).toBe(false);
    expect(
      autoDevGitAllowCheck(ctx, "mcp__donger-git__git_push", {
        repoName: "donger",
        branch: "master",
      }),
    ).toBe(false);
  });

  it("git_create_branch：同 push 口径", () => {
    expect(
      autoDevGitAllowCheck(ctx, "mcp__donger-git__git_create_branch", {
        repoName: "donger",
        branch: "feat-20261017-x",
      }),
    ).toBe(true);
    expect(
      autoDevGitAllowCheck(ctx, "mcp__donger-git__git_create_branch", {
        repoName: "donger",
        branch: "fix-x",
      }),
    ).toBe(false);
  });

  it("git_create_mr：源分支合形 + 目标 master + 标题 [autofix] 才放行", () => {
    const base = { repoName: "donger", source: "fix-20261017-x", target: "master", title: "[autofix] fb-1 修复" };
    expect(autoDevGitAllowCheck(ctx, "mcp__donger-git__git_create_mr", base)).toBe(true);
    expect(autoDevGitAllowCheck(ctx, "mcp__donger-git__git_create_mr", { ...base, target: "main" })).toBe(false);
    expect(autoDevGitAllowCheck(ctx, "mcp__donger-git__git_create_mr", { ...base, title: "普通标题" })).toBe(false);
    expect(autoDevGitAllowCheck(ctx, "mcp__donger-git__git_create_mr", { ...base, source: "master" })).toBe(false);
  });

  it("git_merge_mr 永不放行；kill-switch 全拒", () => {
    expect(
      autoDevGitAllowCheck(ctx, "mcp__donger-git__git_merge_mr", { repoName: "donger", number: "7" }),
    ).toBe(false);
    expect(
      autoDevGitAllowCheck({ ...ctx, disabled: () => true }, "mcp__donger-git__git_push", {
        repoName: "donger",
        branch: "fix-20261017-x",
      }),
    ).toBe(false);
  });

  it("分支名契约：日期段必须 8 位，slug 段允许点连字符", () => {
    expect(AUTOFIX_BRANCH_RE.test("fix-20261017-a.b_c-1")).toBe(true);
    expect(AUTOFIX_BRANCH_RE.test("fix-20261-x")).toBe(false);
    expect(AUTOFIX_BRANCH_RE.test("fix-20261017")).toBe(false);
  });
});

describe("buildAutoFixAgent", () => {
  it("内置常量：admin 模板、工具面含 Bash/Edit/Write 但无 git_merge_mr 入口语义", () => {
    const agent = buildAutoFixAgent();
    expect(agent.id).toBe(BUILTIN_AUTO_FIX_AGENT_ID);
    expect(agent.tools.mode).toBe("whitelist");
    for (const tool of ["Bash", "Edit", "Write", "mcp__donger-git"]) {
      expect(agent.tools.whitelist.some((t) => t === tool || tool.startsWith(t)), tool).toBe(true);
    }
    expect(agent.systemPrompt).toContain("[autofix]");
    expect(agent.systemPrompt).toContain("donger-proposal");
    expect(agent.systemPrompt).toContain("<untrusted>");
  });

  it("仓库绑定注入后 gitRepositories 生效", () => {
    const repo = {
      id: "r1",
      name: "donger",
      provider: "gitee" as const,
      url: "https://gitee.com/o/donger.git",
      required: true,
      shallow: true,
      syncMode: "fastForward" as const,
    };
    expect(buildAutoFixAgent(repo).gitRepositories).toHaveLength(1);
  });
});
