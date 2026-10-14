import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GitCliRepositoryMaterializer } from "../../src/adapters/git-cli-repository-materializer.js";
import type { Conversation } from "../../src/domain/conversation.js";
import type { AgentGitRepository } from "../../src/domain/git.js";
import { sweepSessionWorktrees, type WorktreeGcDeps } from "../../src/orchestrator/worktree-gc.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sourceRepository(): { root: string; repository: AgentGitRepository } {
  const root = mkdtempSync(join(tmpdir(), "wtgc-source-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  writeFileSync(join(root, "README.md"), "hello");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-m", "init"]);
  return {
    root,
    repository: {
      id: "repo-1",
      name: "sample",
      provider: "github",
      url: pathToFileURL(root).toString(),
      ref: "main",
      required: true,
      shallow: false,
      syncMode: "fastForward",
    },
  };
}

function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    userId: "u1",
    sdkSessionId: "",
    title: "t",
    channelId: "web",
    agentId: "a1",
    createdAt: "2026-10-01T00:00:00.000Z",
    // 默认「刚刚活跃」：真实时钟下永不超龄；超龄场景由用例显式改 updatedAt 或注入 now
    updatedAt: new Date().toISOString(),
    archived: false,
    ...over,
  };
}

function fakeConvStore(convs: Conversation[]) {
  const map = new Map(convs.map((c) => [c.id, c]));
  return { get: async (id: string) => map.get(id) };
}

/** 搭好 GC 扫描的目录形态：主克隆在独立区，worktree 落在标准 workspace 路径 */
async function setup(convs: Array<{ id: string; archived?: boolean }>) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "wtgc-ws-"));
  roots.push(workspaceDir);
  const destination = mkdtempSync(join(tmpdir(), "wtgc-repos-"));
  roots.push(destination);
  const { repository } = sourceRepository();
  const materializer = new GitCliRepositoryMaterializer(10_000);
  await materializer.materialize({ destination, items: [{ repository }] });
  const worktreeRoot = join(workspaceDir, "users", "u1", "agents", "a1", "workspace", "worktrees");
  for (const c of convs) {
    await materializer.materialize({
      destination,
      items: [{ repository }],
      session: { conversationId: c.id, worktreeRoot },
    });
  }
  const deps: WorktreeGcDeps = {
    workspaceDir,
    conversationStore: fakeConvStore(
      convs.map((c) => conv(c.id, { archived: c.archived ?? false })),
    ),
    timeoutMs: 10_000,
  };
  const wt = (id: string) => join(worktreeRoot, id, "repos", "sample");
  const mainClone = join(destination, "sample");
  return { deps, wt, mainClone };
}

describe("sweepSessionWorktrees", () => {
  it("归档会话的干净 worktree 回收，未归档保留", { timeout: 30_000 }, async () => {
    const { deps, wt, mainClone } = await setup([
      { id: "conv-a", archived: true },
      { id: "conv-b" },
    ]);

    const summary = await sweepSessionWorktrees(deps);

    expect(summary.scanned).toBe(2);
    expect(summary.removedWorktrees).toBe(1);
    expect(existsSync(wt("conv-a"))).toBe(false);
    expect(existsSync(wt("conv-b"))).toBe(true);
    // 已合并的会话分支随之删除；未归档会话分支保留
    expect(
      execFileSync("git", [
        "-C",
        mainClone,
        "branch",
        "--list",
        "donger-session/conv-a",
      ]).toString(),
    ).toBe("");
    expect(
      execFileSync("git", [
        "-C",
        mainClone,
        "branch",
        "--list",
        "donger-session/conv-b",
      ]).toString(),
    ).toContain("conv-b");
  });

  it("脏 worktree（未提交改动）被 git 拒绝回收，现场保留", { timeout: 30_000 }, async () => {
    const { deps, wt } = await setup([{ id: "conv-a", archived: true }]);
    writeFileSync(join(wt("conv-a"), "README.md"), "dirty work");

    const summary = await sweepSessionWorktrees(deps);

    expect(summary.keptDirty).toBe(1);
    expect(existsSync(wt("conv-a"))).toBe(true);
    expect(readFileSync(join(wt("conv-a"), "README.md"), "utf8")).toBe("dirty work");
  });

  it("未跟踪文件同样阻断回收", { timeout: 30_000 }, async () => {
    const { deps, wt } = await setup([{ id: "conv-a", archived: true }]);
    writeFileSync(join(wt("conv-a"), "scratch.md"), "untracked");

    const summary = await sweepSessionWorktrees(deps);

    expect(summary.keptDirty).toBe(1);
    expect(existsSync(join(wt("conv-a"), "scratch.md"))).toBe(true);
  });

  it("已提交未合并：worktree 回收但会话分支保留（-d 拒绝）", { timeout: 30_000 }, async () => {
    const { deps, wt, mainClone } = await setup([{ id: "conv-a", archived: true }]);
    writeFileSync(join(wt("conv-a"), "feature.md"), "done");
    execFileSync("git", ["-C", wt("conv-a"), "add", "."]);
    execFileSync("git", ["-C", wt("conv-a"), "commit", "-m", "unmerged work"]);

    const summary = await sweepSessionWorktrees(deps);

    expect(summary.removedWorktrees).toBe(1);
    expect(summary.keptBranches).toBe(1);
    expect(existsSync(wt("conv-a"))).toBe(false);
    expect(
      execFileSync("git", [
        "-C",
        mainClone,
        "branch",
        "--list",
        "donger-session/conv-a",
      ]).toString(),
    ).toContain("conv-a");
  });

  it("闲置超龄回收；未知名会话（store 无记录）同样回收", { timeout: 30_000 }, async () => {
    const { deps, wt } = await setup([
      { id: "conv-a" }, // updatedAt 2026-10-01，now=2026-10-20 → 超 7 天
      { id: "conv-b" }, // updatedAt 2026-10-15 → 窗口内保留
      { id: "conv-ghost" }, // store 无记录 → 视为已清理，回收
    ]);
    const map = new Map([
      ["conv-a", conv("conv-a", { updatedAt: "2026-10-01T00:00:00.000Z" })],
      ["conv-b", conv("conv-b", { updatedAt: "2026-10-15T00:00:00.000Z" })],
    ]);
    deps.conversationStore = {
      get: async (id: string) => map.get(id),
    };

    const summary = await sweepSessionWorktrees({
      ...deps,
      now: () => Date.parse("2026-10-20T00:00:00.000Z"),
    });

    expect(summary.removedWorktrees).toBe(2); // conv-a 超龄 + conv-ghost 未知名
    expect(existsSync(wt("conv-a"))).toBe(false);
    expect(existsSync(wt("conv-ghost"))).toBe(false);
    expect(existsSync(wt("conv-b"))).toBe(true);
  });

  it("非 worktree 杂物跳过不删", { timeout: 30_000 }, async () => {
    const { deps, wt } = await setup([{ id: "conv-a", archived: true }]);
    rmSync(wt("conv-a"), { recursive: true, force: true });
    mkdirSync(wt("conv-a"), { recursive: true });
    writeFileSync(join(wt("conv-a"), "junk.txt"), "not a repo");

    const summary = await sweepSessionWorktrees(deps);

    expect(summary.keptDirty).toBe(1);
    expect(existsSync(join(wt("conv-a"), "junk.txt"))).toBe(true);
  });
});
