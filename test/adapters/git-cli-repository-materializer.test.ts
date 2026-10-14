import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GitCliRepositoryMaterializer } from "../../src/adapters/git-cli-repository-materializer.js";
import { type AgentGitRepository, buildCloneArgs } from "../../src/domain/git.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sourceRepository(): { root: string; repository: AgentGitRepository } {
  const root = mkdtempSync(join(tmpdir(), "donger-git-source-"));
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
      shallow: true,
      syncMode: "fastForward",
    },
  };
}

describe("GitCliRepositoryMaterializer", () => {
  it("检查远端并原子 clone 到 repos 目录", { timeout: 30_000 }, async () => {
    const { repository } = sourceRepository();
    const destination = mkdtempSync(join(tmpdir(), "donger-git-dest-"));
    roots.push(destination);
    const materializer = new GitCliRepositoryMaterializer(10_000);

    await expect(materializer.checkRead(repository)).resolves.toEqual({ ok: true });
    const results = await materializer.materialize({
      destination,
      items: [{ repository }],
    });

    expect(results[0]?.status).toBe("ready");
    expect(readFileSync(join(destination, "sample", "README.md"), "utf8")).toBe("hello");
  });

  it("TTL 窗口内复用已同步目录，窗口过后恢复同步", { timeout: 30_000 }, async () => {
    const { root, repository } = sourceRepository();
    const destination = mkdtempSync(join(tmpdir(), "donger-git-dest-"));
    roots.push(destination);
    let nowMs = 1_000_000;
    const materializer = new GitCliRepositoryMaterializer(10_000, 60_000, () => nowMs);

    await materializer.materialize({ destination, items: [{ repository }] });
    // 上游前进一个提交
    writeFileSync(join(root, "README.md"), "v2");
    execFileSync("git", ["-C", root, "add", "README.md"]);
    execFileSync("git", ["-C", root, "commit", "-m", "v2"]);

    // 窗口内：跳过 fetch/merge，仍读旧内容（status=ready，无 warning）
    const within = await materializer.materialize({ destination, items: [{ repository }] });
    expect(within[0]?.status).toBe("ready");
    expect(within[0]?.message).toBeUndefined();
    expect(readFileSync(join(destination, "sample", "README.md"), "utf8")).toBe("hello");

    // 窗口外：恢复同步，读到新内容
    nowMs += 61_000;
    const after = await materializer.materialize({ destination, items: [{ repository }] });
    expect(after[0]?.status).toBe("ready");
    expect(readFileSync(join(destination, "sample", "README.md"), "utf8")).toBe("v2");
  });

  it("已有本地修改时保留内容并返回 warning", { timeout: 30_000 }, async () => {
    const { repository } = sourceRepository();
    const destination = mkdtempSync(join(tmpdir(), "donger-git-dest-"));
    roots.push(destination);
    const materializer = new GitCliRepositoryMaterializer(10_000);
    await materializer.materialize({ destination, items: [{ repository }] });
    writeFileSync(join(destination, "sample", "README.md"), "changed");

    // 同步行为用关闭 TTL 的实例验证（默认 TTL 下窗口内的第二次物化会跳过同步，属预期行为）
    const results = await new GitCliRepositoryMaterializer(10_000, 0).materialize({
      destination,
      items: [{ repository }],
    });

    expect(results[0]?.status).toBe("warning");
    expect(readFileSync(join(destination, "sample", "README.md"), "utf8")).toBe("changed");
  });

  it("克隆覆盖源仓库全部分支（回归：单分支浅克隆致变更查询误报零变更）", {
    timeout: 30_000,
  }, async () => {
    const { root, repository } = sourceRepository();
    execFileSync("git", ["-C", root, "branch", "feature/AI-375"]);
    const destination = mkdtempSync(join(tmpdir(), "donger-git-dest-"));
    roots.push(destination);
    const materializer = new GitCliRepositoryMaterializer(10_000);

    const results = await materializer.materialize({ destination, items: [{ repository }] });
    expect(results[0]?.status).toBe("ready");

    const branches = execFileSync("git", [
      "-C",
      join(destination, "sample"),
      "branch",
      "-r",
    ]).toString();
    expect(branches).toContain("origin/feature/AI-375");

    // 第二次物化走 fast-forward：全量 refspec fetch 不破坏跟踪分支合并（换新实例绕开 TTL 窗口）
    const again = await new GitCliRepositoryMaterializer(10_000, 0).materialize({
      destination,
      items: [{ repository }],
    });
    expect(again[0]?.status).toBe("ready");
  });

  it("已有目录不是目标仓库时备份并重新克隆自愈", { timeout: 30_000 }, async () => {
    const { repository } = sourceRepository();
    const destination = mkdtempSync(join(tmpdir(), "donger-git-dest-"));
    roots.push(destination);
    // 预置一个不是目标仓库的目录（无 remote 的空仓库）
    const stale = join(destination, "sample");
    execFileSync("git", ["init", "-q", stale]);
    writeFileSync(join(stale, "junk.txt"), "old");
    execFileSync("git", ["-C", stale, "add", "junk.txt"]);
    const materializer = new GitCliRepositoryMaterializer(10_000);

    const results = await materializer.materialize({ destination, items: [{ repository }] });

    expect(results[0]?.status).toBe("warning");
    expect(results[0]?.message).toContain("备份");
    // 原路径已换成新克隆，旧现场保留在 .stale-* 备份目录
    expect(readFileSync(join(destination, "sample", "README.md"), "utf8")).toBe("hello");
    const backup = results[0]?.message?.match(/已备份到 (.+?) 并重新克隆/)?.[1] ?? "";
    expect(readFileSync(join(backup, "junk.txt"), "utf8")).toBe("old");
  });
});

describe("GitCliRepositoryMaterializer 会话 worktree 隔离", () => {
  const sessionScope = (destination: string, conversationId: string) => ({
    conversationId,
    worktreeRoot: join(destination, "worktrees"),
  });

  function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-C", root, ...args])
      .toString()
      .trim();
  }

  it("会话模式：物化为会话私有 worktree，分支/upstream/基座分工就位", {
    timeout: 30_000,
  }, async () => {
    const { repository } = sourceRepository();
    const destination = mkdtempSync(join(tmpdir(), "donger-git-dest-"));
    roots.push(destination);
    const materializer = new GitCliRepositoryMaterializer(10_000);

    const results = await materializer.materialize({
      destination,
      items: [{ repository }],
      session: sessionScope(destination, "conv-1"),
    });

    const wt = join(destination, "worktrees", "conv-1", "repos", "sample");
    expect(results[0]?.status).toBe("ready");
    expect(results[0]?.path).toBe(wt);
    expect(readFileSync(join(wt, "README.md"), "utf8")).toBe("hello");
    // 会话分支 + upstream 指向主分支（git_pull 即同步主分支）；主克隆 HEAD 不被移动
    expect(git(wt, "branch", "--show-current")).toBe("donger-session/conv-1");
    expect(git(wt, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
    expect(git(join(destination, "sample"), "branch", "--show-current")).toBe("main");
  });

  it("同一会话重复物化幂等复用；两会话各自独立 worktree 互不可见", {
    timeout: 30_000,
  }, async () => {
    const { repository } = sourceRepository();
    const destination = mkdtempSync(join(tmpdir(), "donger-git-dest-"));
    roots.push(destination);
    const materializer = new GitCliRepositoryMaterializer(10_000, 0);
    const session = sessionScope(destination, "conv-1");

    const first = await materializer.materialize({ destination, items: [{ repository }], session });
    const wt1 = first[0]?.path;
    if (!wt1) throw new Error("conv-1 worktree path missing");
    const again = await materializer.materialize({ destination, items: [{ repository }], session });
    expect(again[0]?.path).toBe(wt1);
    expect(git(wt1, "status", "--porcelain")).toBe("");

    // 第二个会话：独立 worktree + 独立分支；conv-1 的提交不出现在 conv-2
    const conv2 = await materializer.materialize({
      destination,
      items: [{ repository }],
      session: sessionScope(destination, "conv-2"),
    });
    const wt2 = conv2[0]?.path;
    if (!wt2) throw new Error("conv-2 worktree path missing");
    expect(wt2).not.toBe(wt1);
    expect(git(wt2, "branch", "--show-current")).toBe("donger-session/conv-2");
    writeFileSync(join(wt1, "README.md"), "conv1 work");
    execFileSync("git", ["-C", wt1, "add", "."]);
    execFileSync("git", ["-C", wt1, "commit", "-m", "conv1 work"]);
    expect(git(wt2, "log", "--oneline")).not.toContain("conv1 work");
  });

  it("基点取 origin 最新：新会话从远端最新提交开分支", { timeout: 30_000 }, async () => {
    const { root, repository } = sourceRepository();
    const destination = mkdtempSync(join(tmpdir(), "donger-git-dest-"));
    roots.push(destination);
    const materializer = new GitCliRepositoryMaterializer(10_000);
    await materializer.materialize({
      destination,
      items: [{ repository }],
      session: sessionScope(destination, "conv-1"),
    });
    writeFileSync(join(root, "README.md"), "v2");
    execFileSync("git", ["-C", root, "add", "README.md"]);
    execFileSync("git", ["-C", root, "commit", "-m", "v2"]);

    const conv2 = await new GitCliRepositoryMaterializer(10_000, 0).materialize({
      destination,
      items: [{ repository }],
      session: sessionScope(destination, "conv-2"),
    });
    const wt2 = conv2[0]?.path;
    if (!wt2) throw new Error("conv-2 worktree path missing");
    expect(readFileSync(join(wt2, "README.md"), "utf8")).toBe("v2");
  });

  it("脏基座仍 fetch：worktree 基于最新 origin 引用创建", { timeout: 30_000 }, async () => {
    const { root, repository } = sourceRepository();
    const destination = mkdtempSync(join(tmpdir(), "donger-git-dest-"));
    roots.push(destination);
    const mainClone = join(destination, "sample");
    const materializer = new GitCliRepositoryMaterializer(10_000);
    await materializer.materialize({
      destination,
      items: [{ repository }],
      session: sessionScope(destination, "conv-1"),
    });
    writeFileSync(join(root, "README.md"), "v2");
    execFileSync("git", ["-C", root, "add", "README.md"]);
    execFileSync("git", ["-C", root, "commit", "-m", "v2"]);
    // 主克隆遗留脏树（历史会话的旧模式）：fetch 不再被阻断，仅跳过 merge
    writeFileSync(join(mainClone, "README.md"), "dirty");

    const results = await new GitCliRepositoryMaterializer(10_000, 0).materialize({
      destination,
      items: [{ repository }],
      session: sessionScope(destination, "conv-2"),
    });
    expect(results[0]?.status).toBe("warning");
    expect(results[0]?.message).toContain("本地修改");
    const wt2 = results[0]?.path;
    if (!wt2) throw new Error("conv-2 worktree path missing");
    expect(readFileSync(join(wt2, "README.md"), "utf8")).toBe("v2");
  });

  it("异源残留目录改名备份后重建 worktree", { timeout: 30_000 }, async () => {
    const { repository } = sourceRepository();
    const destination = mkdtempSync(join(tmpdir(), "donger-git-dest-"));
    roots.push(destination);
    const wt = join(destination, "worktrees", "conv-1", "repos", "sample");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "junk.txt"), "old");

    const results = await new GitCliRepositoryMaterializer(10_000).materialize({
      destination,
      items: [{ repository }],
      session: sessionScope(destination, "conv-1"),
    });
    expect(results[0]?.status).toBe("ready");
    expect(readFileSync(join(wt, "README.md"), "utf8")).toBe("hello");
    const backupDir = readdirSync(dirname(wt)).find((n) => n.startsWith(`${basename(wt)}.stale-`));
    expect(backupDir).toBeTruthy();
    expect(readFileSync(join(dirname(wt), backupDir ?? "", "junk.txt"), "utf8")).toBe("old");
  });

  it("会话分支残留时重挂既有分支（历史提交不丢）", { timeout: 30_000 }, async () => {
    const { repository } = sourceRepository();
    const destination = mkdtempSync(join(tmpdir(), "donger-git-dest-"));
    roots.push(destination);
    const materializer = new GitCliRepositoryMaterializer(10_000);
    const session = sessionScope(destination, "conv-1");
    const first = await materializer.materialize({ destination, items: [{ repository }], session });
    const wt = first[0]?.path;
    if (!wt) throw new Error("conv-1 worktree path missing");
    writeFileSync(join(wt, "notes.md"), "wip");
    execFileSync("git", ["-C", wt, "add", "."]);
    execFileSync("git", ["-C", wt, "commit", "-m", "wip-on-session"]);
    // 模拟 GC/人工清理了 worktree 目录，但分支保留
    execFileSync("git", ["-C", join(destination, "sample"), "worktree", "remove", wt]);
    expect(existsSync(wt)).toBe(false);

    const again = await new GitCliRepositoryMaterializer(10_000, 0).materialize({
      destination,
      items: [{ repository }],
      session,
    });
    expect(again[0]?.path).toBe(wt);
    expect(git(wt, "branch", "--show-current")).toBe("donger-session/conv-1");
    expect(git(wt, "log", "--oneline")).toContain("wip-on-session");
    expect(git(wt, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
  });
});

describe("buildCloneArgs", () => {
  const base = {
    id: "r1",
    name: "sample",
    provider: "jihulab" as const,
    url: "https://jihulab.com/acme/sample.git",
    required: true,
    shallow: true,
    syncMode: "fastForward" as const,
  };

  it("浅克隆默认 blobless partial clone（全分支，不再用 depth 1）", () => {
    expect(buildCloneArgs(base, "/tmp/d")).toEqual([
      "clone",
      "--no-recurse-submodules",
      "--filter=blob:none",
      "--no-single-branch",
      base.url,
      "/tmp/d",
    ]);
  });

  it("shallowSince 追加 --shallow-since", () => {
    const args = buildCloneArgs({ ...base, shallowSince: "1 year ago" }, "/tmp/d");
    expect(args).toContain("--shallow-since");
    expect(args[args.indexOf("--shallow-since") + 1]).toBe("1 year ago");
    // 窗口模式仍为浅克隆：必须显式保留全部分支
    expect(args).toContain("--no-single-branch");
  });

  it("非浅克隆不附带 filter/shallow-since", () => {
    const args = buildCloneArgs({ ...base, shallow: false, shallowSince: "1 year ago" }, "/tmp/d");
    expect(args).not.toContain("--filter=blob:none");
    expect(args).not.toContain("--shallow-since");
  });

  it("ref 映射为 --branch", () => {
    const args = buildCloneArgs({ ...base, ref: "main", shallow: false }, "/tmp/d");
    expect(args).toEqual([
      "clone",
      "--no-recurse-submodules",
      "--branch",
      "main",
      base.url,
      "/tmp/d",
    ]);
  });
});
