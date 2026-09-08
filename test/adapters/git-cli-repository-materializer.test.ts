import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCloneArgs,
  GitCliRepositoryMaterializer,
} from "../../src/adapters/git-cli-repository-materializer.js";
import type { AgentGitRepository } from "../../src/domain/git.js";

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
  it("检查远端并原子 clone 到 repos 目录", async () => {
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

  it("已有本地修改时保留内容并返回 warning", async () => {
    const { repository } = sourceRepository();
    const destination = mkdtempSync(join(tmpdir(), "donger-git-dest-"));
    roots.push(destination);
    const materializer = new GitCliRepositoryMaterializer(10_000);
    await materializer.materialize({ destination, items: [{ repository }] });
    writeFileSync(join(destination, "sample", "README.md"), "changed");

    const results = await materializer.materialize({ destination, items: [{ repository }] });

    expect(results[0]?.status).toBe("warning");
    expect(readFileSync(join(destination, "sample", "README.md"), "utf8")).toBe("changed");
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

  it("浅克隆默认 depth 1", () => {
    expect(buildCloneArgs(base, "/tmp/d")).toEqual([
      "clone",
      "--no-recurse-submodules",
      "--depth",
      "1",
      base.url,
      "/tmp/d",
    ]);
  });

  it("shallowSince 追加 --shallow-since", () => {
    const args = buildCloneArgs({ ...base, shallowSince: "1 year ago" }, "/tmp/d");
    expect(args).toContain("--shallow-since");
    expect(args[args.indexOf("--shallow-since") + 1]).toBe("1 year ago");
  });

  it("非浅克隆不附带 depth/shallow-since", () => {
    const args = buildCloneArgs({ ...base, shallow: false, shallowSince: "1 year ago" }, "/tmp/d");
    expect(args).not.toContain("--depth");
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
