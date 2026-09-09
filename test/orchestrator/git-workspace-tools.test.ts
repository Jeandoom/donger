import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../src/domain/agent.js";
import type { User } from "../../src/domain/user.js";
import { gitPlatformToolDefinitions } from "../../src/orchestrator/git-platform-tools.js";
import { gitWorkspaceToolDefinitions } from "../../src/orchestrator/git-workspace-tools.js";
import type { CredentialSetStore } from "../../src/ports/credential-set-store.js";
import type { GitProcessResult } from "../../src/util/git-process.js";

const USER: User = {
  id: "u1",
  name: "U",
  role: "user",
  homeDir: "/u1",
  createdAt: "t",
  updatedAt: "t",
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function buildAgent(
  repoOverrides: Partial<{ provider: string; url: string; credentialCode?: string }> = {},
) {
  return {
    id: "a1",
    ownerId: "u1",
    name: "A",
    skills: [],
    tools: { mode: "all", whitelist: [] },
    mcpServers: [],
    credentials: [],
    gitRepositories: [
      {
        id: "r1",
        name: "demo",
        provider: (repoOverrides.provider ?? "jihulab") as "jihulab",
        url: repoOverrides.url ?? "https://jihulab.com/acme/demo.git",
        required: true,
        shallow: true,
        syncMode: "fastForward" as const,
        credentialCode:
          "credentialCode" in repoOverrides ? repoOverrides.credentialCode : "jihulab-pat",
      },
    ],
    extensionDirectories: [],
    llm: {},
    version: 1,
    createdAt: "t",
    updatedAt: "t",
  } as unknown as Agent;
}

/** 测试用宽化 handler 签名：SDK 的 (args, extra) 双参 + 联合 content 收窄为断言友好的形态 */
type ToolResultLike = { isError?: boolean; content: Array<{ text: string }> };
function findTool(
  tools: ReturnType<typeof gitWorkspaceToolDefinitions>,
  name: string,
): { handler: (args: unknown) => Promise<ToolResultLike> } {
  const t = tools.find((d) => d.name === name);
  if (!t) throw new Error(`tool 不存在: ${name}`);
  return t as unknown as { handler: (args: unknown) => Promise<ToolResultLike> };
}

function fakeCredentialSets(values: Record<string, string> | undefined) {
  return {
    getFilledValues: vi.fn(async (uid: string, codes: string[]) =>
      values === undefined
        ? []
        : codes.map((code) => ({
            userId: uid,
            code,
            values,
            createdAt: "t",
            updatedAt: "t",
          })),
    ),
  } as unknown as CredentialSetStore;
}

type Runner = (
  args: string[],
  credential?: { username: string; accessToken: string },
) => Promise<GitProcessResult>;

/** 记录调用参数的 mock git runner；按 args 里的子命令分发预设响应 */
function mockRunner(respond: (args: string[]) => Partial<GitProcessResult> | undefined): Runner & {
  calls: string[][];
  credentials: Array<{ username: string; accessToken: string } | undefined>;
} {
  const calls: string[][] = [];
  const credentials: Array<{ username: string; accessToken: string } | undefined> = [];
  const fn = (async (args: string[], credential?: { username: string; accessToken: string }) => {
    calls.push(args);
    credentials.push(credential);
    const preset = respond(args);
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...preset };
  }) as Runner & {
    calls: string[][];
    credentials: Array<{ username: string; accessToken: string } | undefined>;
  };
  fn.calls = calls;
  fn.credentials = credentials;
  return fn;
}

function setup(
  agent: Agent,
  opts: {
    values?: Record<string, string> | undefined;
    runner?: Runner;
    reposRoot?: string;
  } = {},
) {
  const runner =
    opts.runner ??
    mockRunner((args) =>
      args.includes("status") || args.includes("diff") ? { code: 0, stdout: "" } : undefined,
    );
  const deps = {
    user: USER,
    agent,
    credentialSets: fakeCredentialSets("values" in opts ? opts.values : { token: "pat-1" }),
    reposRoot: opts.reposRoot ?? mkdtempSync(join(tmpdir(), "donger-git-tools-")),
    gitRunner: runner,
  };
  roots.push(deps.reposRoot);
  return { tools: gitWorkspaceToolDefinitions(deps), deps, runner };
}

describe("donger-git CLI 工作区工具", () => {
  it("未绑定的仓库名报引导错", async () => {
    const { tools } = setup(buildAgent());
    const r = await findTool(tools, "git_status").handler({ repoName: "nope" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("nope");
    expect(r.content[0]?.text).toContain("demo");
  });

  it("reposRoot 未注入时统一报工作区不可用", async () => {
    const runner = mockRunner(() => undefined);
    const tools = gitWorkspaceToolDefinitions({
      user: USER,
      agent: buildAgent(),
      reposRoot: undefined,
      gitRunner: runner,
    });
    const r = await findTool(tools, "git_status").handler({ repoName: "demo" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("reposRoot");
    expect(runner.calls).toHaveLength(0);
  });

  it("git_clone：成功后临时目录原子改名为正式目录", async () => {
    const { tools, deps } = setup(buildAgent(), {
      runner: mockRunner((args) => {
        if (args[0] === "clone") {
          // 模拟 clone 产物：在临时目录写文件，供 rename 断言
          mkdirSync(args[args.length - 1], { recursive: true });
          writeFileSync(join(args[args.length - 1], "README.md"), "x");
        }
        return undefined;
      }),
    });
    const r = await findTool(tools, "git_clone").handler({ repoName: "demo" });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain(join(deps.reposRoot, "demo").slice(0, 20));
    expect(existsSync(join(deps.reposRoot, "demo", "README.md"))).toBe(true);
    expect(existsSync(join(deps.reposRoot, "demo") + ".clone-")).toBe(false);
  });

  it("git_clone：目录已存在时拒绝并引导用 git_pull", async () => {
    const { tools, deps } = setup(buildAgent());
    mkdirSync(join(deps.reposRoot, "demo"), { recursive: true });
    const r = await findTool(tools, "git_clone").handler({ repoName: "demo" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("git_pull");
  });

  it("git_push：无凭证给引导；有凭证时携带 username/token 且参数含目标分支", async () => {
    const noCred = setup(buildAgent({ credentialCode: undefined }), {
      values: undefined,
      runner: mockRunner(() => undefined),
    });
    const r1 = await findTool(noCred.tools, "git_push").handler({
      repoName: "demo",
      branch: "main",
    });
    expect(r1.isError).toBe(true);
    expect(r1.content[0]?.text).toContain("credentialCode");

    const runner = mockRunner(() => undefined);
    const { tools } = setup(buildAgent(), { runner });
    const r2 = await findTool(tools, "git_push").handler({ repoName: "demo", branch: "feat" });
    expect(r2.isError).toBeFalsy();
    expect(runner.credentials[0]).toEqual({ username: "oauth2", accessToken: "pat-1" });
    const pushArgs = runner.calls.find((c) => c.includes("push")) ?? [];
    expect(pushArgs).toContain("HEAD:refs/heads/feat");
    expect(pushArgs).not.toContain("--force");
  });

  it("git_push force 追加 --force；错误输出脱敏", async () => {
    const runner = mockRunner((args) =>
      args.includes("push")
        ? {
            code: 1,
            stderr:
              "fatal: could not read Username for 'https://x-token:secret123@jihulab.com': OK",
          }
        : undefined,
    );
    const { tools } = setup(buildAgent(), { runner });
    const r = await findTool(tools, "git_push").handler({
      repoName: "demo",
      branch: "main",
      force: true,
    });
    expect(r.isError).toBe(true);
    const pushArgs = runner.calls.find((c) => c.includes("push")) ?? [];
    expect(pushArgs).toContain("--force");
    expect(r.content[0]?.text).not.toContain("secret123");
  });

  it("git_pull：脏工作区拒绝；干净时 fetch+merge，ff 失败提示 merge 策略", async () => {
    const dirtyRunner = mockRunner((args) =>
      args.includes("status") ? { code: 0, stdout: " M file.ts\n" } : undefined,
    );
    const dirty = setup(buildAgent(), { runner: dirtyRunner });
    const r1 = await findTool(dirty.tools, "git_pull").handler({ repoName: "demo" });
    expect(r1.isError).toBe(true);
    expect(r1.content[0]?.text).toContain("git_commit");

    const ffFailRunner = mockRunner((args) => {
      if (args.includes("status")) return { code: 0, stdout: "" };
      if (args.includes("merge")) return { code: 1, stderr: "Not possible to fast-forward" };
      return undefined;
    });
    const ff = setup(buildAgent(), { runner: ffFailRunner });
    const r2 = await findTool(ff.tools, "git_pull").handler({ repoName: "demo" });
    expect(r2.isError).toBe(true);
    expect(r2.content[0]?.text).toContain("strategy=merge");

    const okRunner = mockRunner((args) => {
      if (args.includes("status")) return { code: 0, stdout: "" };
      if (args.includes("merge")) return { code: 0, stdout: "Updating abc..def\nFast-forward" };
      return undefined;
    });
    const clean = setup(buildAgent(), { runner: okRunner });
    const r3 = await findTool(clean.tools, "git_pull").handler({ repoName: "demo" });
    expect(r3.isError).toBeFalsy();
    expect(r3.content[0]?.text).toContain("Fast-forward");
  });

  it("git_commit：暂存区为空报错；有差异时以 donger-agent 身份提交", async () => {
    const emptyRunner = mockRunner((args) => (args.includes("diff") ? { code: 0 } : undefined));
    const empty = setup(buildAgent(), { runner: emptyRunner });
    const r1 = await findTool(empty.tools, "git_commit").handler({
      repoName: "demo",
      message: "m1",
    });
    expect(r1.isError).toBe(true);
    expect(r1.content[0]?.text).toContain("没有可提交");

    const runner = mockRunner((args) => (args.includes("diff") ? { code: 1 } : undefined));
    const { tools } = setup(buildAgent(), { runner });
    const r2 = await findTool(tools, "git_commit").handler({
      repoName: "demo",
      message: "fix: bug",
      addAll: true,
    });
    expect(r2.isError).toBeFalsy();
    const commitArgs = runner.calls.find((c) => c.includes("commit")) ?? [];
    expect(commitArgs).toContain("user.name=donger-agent");
    expect(commitArgs).toContain("-m");
    expect(commitArgs[commitArgs.indexOf("-m") + 1]).toBe("fix: bug");
  });

  it("git_merge 合并指定分支", async () => {
    const runner = mockRunner(() => ({ code: 0, stdout: "Merge made by 'ort' strategy." }));
    const { tools } = setup(buildAgent(), { runner });
    const r = await findTool(tools, "git_merge").handler({
      repoName: "demo",
      sourceBranch: "feature-x",
    });
    expect(r.isError).toBeFalsy();
    const mergeArgs = runner.calls.find((c) => c.includes("merge")) ?? [];
    expect(mergeArgs[mergeArgs.indexOf("merge") + 1]).toBe("feature-x");
  });

  it("donger-git server 装配包含 CLI 工具与平台工具", () => {
    const { tools } = setup(buildAgent());
    const names = [
      ...gitPlatformToolDefinitions({
        user: USER,
        agent: buildAgent(),
        credentialSets: fakeCredentialSets({ token: "t" }),
      }),
    ].map((t) => t.name);
    expect(names).toContain("git_platform_list_branches");
    const ws = [
      "git_clone",
      "git_fetch",
      "git_pull",
      "git_status",
      "git_commit",
      "git_merge",
      "git_push",
    ];
    for (const name of ws) expect(tools.map((t) => t.name)).toContain(name);
  });
});
