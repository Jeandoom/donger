import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
