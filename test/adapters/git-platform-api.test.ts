import { describe, expect, it, vi } from "vitest";
import {
  createGitPlatformApiResolver,
  resolveApiBase,
} from "../../src/adapters/git-platform-api-resolver.js";
import { GiteePlatformApi } from "../../src/adapters/gitee-platform-api.js";
import { GitHubPlatformApi } from "../../src/adapters/github-platform-api.js";
import { GitLabPlatformApi } from "../../src/adapters/gitlab-platform-api.js";

/** 捕获请求的 fetch 桩：返回预设 status/body */
function stubFetch(status: number, body: string) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return { status, text: async () => body } as Response;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("GitPlatformApi 三平台契约", () => {
  it("GitLab：PRIVATE-TOKEN 头 + 子组路径整体编码 + 写操作 body 字段", async () => {
    const { fn, calls } = stubFetch(201, '{"http_url_to_repo":"https://jihulab.com/g/s/r.git"}');
    const api = new GitLabPlatformApi(undefined, fn);

    const branches = await api.listBranches({ repositoryPath: "g/s/r", perPage: 5 }, "tok");
    expect(branches.ok).toBe(true);
    expect(calls[0]?.url).toBe(
      "https://jihulab.com/api/v4/projects/g%2Fs%2Fr/repository/branches?per_page=5",
    );
    expect(calls[0]?.init.headers).toMatchObject({ "PRIVATE-TOKEN": "tok" });

    await api.createMr(
      {
        repositoryPath: "g/s/r",
        source: "feat",
        target: "main",
        title: "t",
        description: "d",
      },
      "tok",
    );
    const mr = calls[1] ?? { url: "", init: {} };
    expect(mr.url).toContain("/projects/g%2Fs%2Fr/merge_requests");
    expect(JSON.parse(mr.init.body as string)).toMatchObject({
      source_branch: "feat",
      target_branch: "main",
      title: "t",
    });

    await api.mergeMr({ repositoryPath: "g/s/r", number: "7" }, "tok");
    expect(calls[2]?.url).toContain("/merge_requests/7/merge");
  });

  it("GitHub：Bearer 头 + createBranch 三步（默认分支→sha→建 ref）", async () => {
    let step = 0;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      step += 1;
      if (step === 1)
        return { status: 200, text: async () => '{"default_branch":"trunk"}' } as Response;
      if (step === 2)
        return { status: 200, text: async () => '{"object":{"sha":"abc123"}}' } as Response;
      return { status: 201, text: async () => '{"ref":"refs/heads/new-branch"}' } as Response;
    }) as unknown as typeof fetch;
    const api = new GitHubPlatformApi(undefined, fn);

    const result = await api.createBranch({ repositoryPath: "acme/repo", branch: "nb" }, "tok");
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/repo");
    expect(calls[1]?.url).toBe("https://api.github.com/repos/acme/repo/git/ref/heads/trunk");
    expect(calls[2]?.url).toBe("https://api.github.com/repos/acme/repo/git/refs");
    expect(JSON.parse(calls[2]?.init.body as string)).toEqual({
      ref: "refs/heads/nb",
      sha: "abc123",
    });
    expect(calls[0]?.init.headers).toMatchObject({ authorization: "Bearer tok" });

    const merged = await api.mergeMr({ repositoryPath: "acme/repo", number: "12" }, "tok");
    expect(merged.ok).toBe(true);
    expect(calls[3]?.url).toContain("/pulls/12/merge");
  });

  it("Gitee：access_token query 参数 + base64 文件解码 + 流水线不支持", async () => {
    const content = Buffer.from("print('hi')").toString("base64");
    const { fn, calls } = stubFetch(200, `{"content":"${content}","encoding":"base64"}`);
    const api = new GiteePlatformApi(undefined, fn);

    const raw = await api.getFileRaw({ repositoryPath: "acme/repo", filePath: "a.py" }, "tok");
    expect(raw.ok).toBe(true);
    expect(raw.body).toBe("print('hi')");
    expect(calls[0]?.url).toBe(
      "https://gitee.com/api/v5/repos/acme/repo/contents/a.py?access_token=tok",
    );

    const pipe = await api.latestPipeline({ repositoryPath: "acme/repo" }, "tok");
    expect(pipe.ok).toBe(false);
    expect(pipe.body).toContain("暂无通用流水线");
  });

  it("401/403 归一为 scope 引导；429 归一为限流提示", async () => {
    const api = new GitHubPlatformApi(undefined, stubFetch(403, "forbidden").fn);
    const r = await api.listBranches({ repositoryPath: "a/b" }, "tok");
    expect(r.ok).toBe(false);
    expect(r.body).toContain("scope");

    const api2 = new GitLabPlatformApi(undefined, stubFetch(429, "slow down").fn);
    const r2 = await api2.listBranches({ repositoryPath: "a/b" }, "tok");
    expect(r2.body).toContain("限流");
  });

  it("resolver：按 provider 复用客户端实例", () => {
    const resolve = createGitPlatformApiResolver();
    expect(resolve("jihulab", "jihulab.com")).toBe(resolve("jihulab", "jihulab.com"));
    expect(resolve("github", "github.com")?.provider).toBe("github");
    expect(resolve("gitee", "gitee.com")?.provider).toBe("gitee");
  });

  it("resolveApiBase：GHE 走 host/api/v3，官方域名走平台惯用根", () => {
    expect(resolveApiBase("github", "github.com")).toBe("https://api.github.com");
    expect(resolveApiBase("github", "ghe.corp.io")).toBe("https://ghe.corp.io/api/v3");
    expect(resolveApiBase("jihulab", "gitlab.corp.io")).toBe("https://gitlab.corp.io/api/v4");
    expect(resolveApiBase("gitee", "gitee.com")).toBe("https://gitee.com/api/v5");
  });
});
