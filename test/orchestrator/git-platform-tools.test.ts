import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../../src/domain/agent.js";
import type { User } from "../../src/domain/user.js";
import { gitPlatformToolDefinitions } from "../../src/orchestrator/git-platform-tools.js";
import type { CredentialSetStore } from "../../src/ports/credential-set-store.js";

const USER: User = {
  id: "u1",
  name: "U",
  role: "user",
  homeDir: "/u1",
  createdAt: "t",
  updatedAt: "t",
};

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
        name: "aix-py",
        provider: (repoOverrides.provider ?? "jihulab") as "jihulab",
        url: repoOverrides.url ?? "https://jihulab.com/your-org/your-project.git",
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
  } as Agent;
}

function fakeCredentialSets(values: Record<string, string> | undefined) {
  return {
    getFilledValues: vi.fn(async (_uid: string, codes: string[]) =>
      values === undefined
        ? []
        : codes.map((code) => ({
            userId: _uid,
            code,
            values,
            createdAt: "t",
            updatedAt: "t",
          })),
    ),
  } as unknown as CredentialSetStore;
}

function fakeFetch(status: number, body: string) {
  return vi.fn(async () => ({ status, text: async () => body }) as Response);
}

function setup(
  agent: Agent,
  opts?: { values?: Record<string, string> | undefined; fetchImpl?: typeof fetch },
) {
  const values = opts && "values" in opts ? opts.values : { token: "pat-1" };
  return gitPlatformToolDefinitions({
    user: USER,
    agent,
    credentialSets: fakeCredentialSets(values),
    fetchImpl: opts?.fetchImpl ?? fakeFetch(200, "[]"),
  });
}

function findTool(tools: ReturnType<typeof gitPlatformToolDefinitions>, name: string) {
  const t = tools.find((d) => d.name === name);
  if (!t) throw new Error(`tool 不存在: ${name}`);
  return t;
}

describe("donger-git 平台工具", () => {
  it("未绑定的仓库名报引导错并列出可用仓库", async () => {
    const tools = setup(buildAgent());
    const r = await findTool(tools, "git_platform_list_branches").handler({ repoName: "nope" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("nope");
    expect(r.content[0]?.text).toContain("aix-py");
  });

  it("github 仓库走 GitHub API（Bearer 头 + owner/repo 路径）", async () => {
    const fetchImpl = fakeFetch(200, '[{"name":"main"}]');
    const tools = setup(
      buildAgent({ provider: "github", url: "https://github.com/acme/repo.git" }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const r = await findTool(tools, "git_platform_list_branches").handler({ repoName: "aix-py" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toContain("main");
    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(call).toBe("https://api.github.com/repos/acme/repo/branches?per_page=20");
    const headers = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      headers: Record<string, string>;
    };
    expect(headers.headers.authorization).toBe("Bearer pat-1");
  });

  it("仓库未绑凭证模板 / 用户未填值时分别给引导", async () => {
    const noCode = setup(buildAgent({ credentialCode: undefined }), { values: { token: "x" } });
    const r1 = await findTool(noCode, "git_platform_list_branches").handler({
      repoName: "aix-py",
    });
    expect(r1.content[0]?.text).toContain("credentialCode");

    const noValue = setup(buildAgent(), { values: undefined });
    const r2 = await findTool(noValue, "git_platform_list_branches").handler({
      repoName: "aix-py",
    });
    expect(r2.content[0]?.text).toContain("jihulab-pat");
  });

  it("list_branches：项目路径 URL 编码 + PRIVATE-TOKEN 头 + 正常返回", async () => {
    const fetchImpl = fakeFetch(200, '[{"name":"master","protected":true}]');
    const tools = setup(buildAgent(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await findTool(tools, "git_platform_list_branches").handler({
      repoName: "aix-py",
      perPage: 50,
    });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toContain("master");
    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(call).toBe(
      "https://jihulab.com/api/v4/projects/your-org%2Fyour-project/repository/branches?per_page=50",
    );
  });

  it("get_file_raw：文件路径整体编码并透传 ref", async () => {
    const fetchImpl = fakeFetch(200, "print('hello')");
    const tools = setup(buildAgent(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await findTool(tools, "git_platform_get_file_raw").handler({
      repoName: "aix-py",
      filePath: "app/core/config.py",
      ref: "dev",
    });
    expect(r.isError).toBeUndefined();
    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(call).toContain("/repository/files/app%2Fcore%2Fconfig.py/raw?ref=dev");
  });

  it("401 转译为凭证无效提示", async () => {
    const tools = setup(buildAgent(), { fetchImpl: fakeFetch(401, "unauthorized") });
    const r = await findTool(tools, "git_platform_list_mrs").handler({ repoName: "aix-py" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("凭证无效");
  });

  it("超长输出截断", async () => {
    const big = "x".repeat(50_000);
    const tools = setup(buildAgent(), { fetchImpl: fakeFetch(200, big) });
    const r = await findTool(tools, "git_platform_get_branch").handler({
      repoName: "aix-py",
      branch: "master",
    });
    expect((r.content[0]?.text ?? "").length).toBeLessThan(50_000);
    expect(r.content[0]?.text).toContain("已截断");
  });

  it("git_create_repo：平台不在绑定集合拒绝；成功返回克隆地址与绑定提示", async () => {
    const giteeOnly = buildAgent({ provider: "gitee", url: "https://gitee.com/acme/repo.git" });
    const tools = gitPlatformToolDefinitions({
      user: USER,
      agent: giteeOnly,
      credentialSets: fakeCredentialSets({ token: "tok" }),
      platformApis: (provider) =>
        provider === "gitee"
          ? {
              provider,
              createRepo: async () => ({
                ok: true,
                status: 201,
                body: '{"html_url":"https://gitee.com/u/newrepo"}',
              }),
              createBranch: async () => ({ ok: true, status: 201, body: "{}" }),
              createMr: async () => ({ ok: true, status: 201, body: "{}" }),
              mergeMr: async () => ({ ok: true, status: 200, body: "{}" }),
              listBranches: async () => ({ ok: true, status: 200, body: "[]" }),
              getBranch: async () => ({ ok: true, status: 200, body: "{}" }),
              listMr: async () => ({ ok: true, status: 200, body: "[]" }),
              getMr: async () => ({ ok: true, status: 200, body: "{}" }),
              latestPipeline: async () => ({ ok: false, status: 0, body: "不支持" }),
              getFileRaw: async () => ({ ok: true, status: 200, body: "x" }),
            }
          : undefined,
    });
    const r1 = await findTool(tools, "git_create_repo").handler({
      provider: "github",
      name: "newrepo",
      private: true,
    });
    expect(r1.isError).toBe(true);
    expect(r1.content[0]?.text).toContain("github");

    const r2 = await findTool(tools, "git_create_repo").handler({
      provider: "gitee",
      name: "newrepo",
      private: false,
    });
    expect(r2.isError).toBeUndefined();
    expect(r2.content[0]?.text).toContain("https://gitee.com/u/newrepo");
    expect(r2.content[0]?.text).toContain("绑定");
  });

  it("git_create_branch / git_create_mr / git_merge_mr 参数透传给平台 adapter", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tools = gitPlatformToolDefinitions({
      user: USER,
      agent: buildAgent(),
      credentialSets: fakeCredentialSets({ token: "tok" }),
      platformApis: (provider) => ({
        provider,
        createRepo: async () => ({ ok: true, status: 201, body: "{}" }),
        createBranch: async (input) => {
          calls.push({ op: "branch", ...input });
          return { ok: true, status: 201, body: "{}" };
        },
        createMr: async (input) => {
          calls.push({ op: "mr", ...input });
          return { ok: true, status: 201, body: "{}" };
        },
        mergeMr: async (input) => {
          calls.push({ op: "merge", ...input });
          return { ok: true, status: 200, body: "{}" };
        },
        listBranches: async () => ({ ok: true, status: 200, body: "[]" }),
        getBranch: async () => ({ ok: true, status: 200, body: "{}" }),
        listMr: async () => ({ ok: true, status: 200, body: "[]" }),
        getMr: async () => ({ ok: true, status: 200, body: "{}" }),
        latestPipeline: async () => ({ ok: false, status: 0, body: "不支持" }),
        getFileRaw: async () => ({ ok: true, status: 200, body: "x" }),
      }),
    });
    await findTool(tools, "git_create_branch").handler({
      repoName: "aix-py",
      branch: "nb",
      fromRef: "dev",
    });
    await findTool(tools, "git_create_mr").handler({
      repoName: "aix-py",
      source: "nb",
      target: "main",
      title: "T",
    });
    await findTool(tools, "git_merge_mr").handler({ repoName: "aix-py", number: "9" });
    expect(calls[0]).toMatchObject({
      op: "branch",
      repositoryPath: "your-org/your-project",
      branch: "nb",
      fromRef: "dev",
    });
    expect(calls[1]).toMatchObject({ op: "mr", source: "nb", target: "main", title: "T" });
    expect(calls[2]).toMatchObject({ op: "merge", number: "9" });
  });
});
