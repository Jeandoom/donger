import { describe, expect, it } from "vitest";
import {
  AgentGitRepositoriesSchema,
  AgentGitRepositorySchema,
  gitRepositoryFingerprint,
  inferGitProvider,
  isBlockedHost,
  normalizeRepositoryIdentity,
  parseRepositoryUrl,
  validateGitCredentialBindings,
} from "../../src/domain/git.js";

const repository = {
  id: "repo-1",
  name: "backend",
  provider: "github" as const,
  url: "https://github.com/acme/backend.git",
  ref: "main",
  required: true,
  shallow: true,
  syncMode: "fastForward" as const,
};

describe("Agent Git repository", () => {
  it.each([
    ["https://github.com/acme/repo.git", "github"],
    ["https://gitee.com/acme/repo.git", "gitee"],
    ["https://jihulab.com/acme/repo.git", "jihulab"],
  ] as const)("从 %s 推断平台", (url, provider) => {
    expect(inferGitProvider(url)).toBe(provider);
  });

  it("生成不含凭证和 .git 后缀的仓库指纹", () => {
    expect(gitRepositoryFingerprint(repository)).toBe("github.com/acme/backend");
  });

  it("拒绝平台与 URL host 不匹配", () => {
    expect(() =>
      AgentGitRepositoriesSchema.parse([{ ...repository, provider: "gitee" }]),
    ).toThrow();
  });

  it.each([
    "http://github.com/acme/backend.git",
    "https://token@github.com/acme/backend.git",
    "file:///tmp/backend",
    "https://github.com/acme/backend.git?token=x",
  ])("拒绝不安全 URL：%s", (url) => {
    expect(() => AgentGitRepositoriesSchema.parse([{ ...repository, url }])).toThrow();
  });

  it("拒绝重复 id 和目录名", () => {
    expect(() =>
      AgentGitRepositoriesSchema.parse([
        repository,
        { ...repository, url: "https://github.com/acme/other.git" },
      ]),
    ).toThrow();
  });

  it("接受合法 credentialCode 与 shallowSince", () => {
    const parsed = AgentGitRepositoriesSchema.parse([
      {
        ...repository,
        credentialCode: "jihulab-pat",
        shallowSince: "1 year ago",
      },
    ]);
    expect(parsed[0]?.credentialCode).toBe("jihulab-pat");
    expect(parsed[0]?.shallowSince).toBe("1 year ago");
  });

  it.each(["Bad Code", "-bad", "UPPER", "x".repeat(65)])("拒绝非法 credentialCode：%s", (code) => {
    expect(() =>
      AgentGitRepositoriesSchema.parse([
        { ...repository, url: "https://github.com/acme/o.git", id: "o", credentialCode: code },
      ]),
    ).toThrow();
  });

  it("shallowSince 长度超限报错", () => {
    expect(() =>
      AgentGitRepositoriesSchema.parse([
        {
          ...repository,
          url: "https://github.com/acme/o.git",
          id: "o",
          shallowSince: "x".repeat(65),
        },
      ]),
    ).toThrow();
  });
});

describe("多 host 支持（spec 2026-09-10）", () => {
  it("自建 host 合法且 knownProvider 为空；官方域名仍推断方言", () => {
    const custom = parseRepositoryUrl("https://gitlab.corp.example.com/team/app.git");
    expect(custom?.host).toBe("gitlab.corp.example.com");
    expect(custom?.repositoryPath).toBe("team/app");
    expect(custom?.knownProvider).toBeUndefined();
    // 方言与官方域名冲突才报错；未知 host 不限制 provider 选择
    expect(() =>
      AgentGitRepositorySchema.parse({
        id: "r",
        name: "app",
        provider: "jihulab",
        url: "https://gitlab.corp.example.com/team/app.git",
      }),
    ).not.toThrow();
    expect(() =>
      AgentGitRepositorySchema.parse({
        id: "r",
        name: "app",
        provider: "gitee",
        url: "https://github.com/acme/app.git",
      }),
    ).toThrow(/不匹配/);
    expect(parseRepositoryUrl("https://ghe.corp.io/acme/app.git")?.host).toBe("ghe.corp.io");
  });

  it("isBlockedHost：多用户部署默认拒内网/元数据，开关放行", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "172.16.0.9",
      "172.31.255.1",
      "169.254.169.254",
      "0.0.0.0",
      "[::1]",
      "metadata.google.internal",
    ]) {
      expect(isBlockedHost(host, false), host).toBe(true);
      expect(isBlockedHost(host, true), host).toBe(false);
    }
    for (const host of ["github.com", "gitlab.corp.example.com", "8.8.8.8", "172.32.0.1"]) {
      expect(isBlockedHost(host, false), host).toBe(false);
    }
  });

  it("normalizeRepositoryIdentity：host 小写 + path 归一", () => {
    expect(normalizeRepositoryIdentity("https://GitHub.com/Acme/App.git")).toBe(
      "github.com/acme/app",
    );
    expect(normalizeRepositoryIdentity("https://ghe.corp.io/acme/app")).toBe(
      "ghe.corp.io/acme/app",
    );
  });
});

describe("凭证仓库绑定一致性（spec 2026-09-10 §3.3）", () => {
  const repo = (url: string, code?: string) => ({
    id: "r1",
    name: "app",
    provider: "jihulab" as const,
    url,
    required: true,
    shallow: true,
    syncMode: "fastForward" as const,
    credentialCode: code,
  });

  it("仓库级凭证地址一致通过；不一致报错并给出两个地址", () => {
    const templates = new Map([
      ["c1", { repoUrl: "https://jihulab.com/acme/app.git" }],
      ["c2", { repoUrl: "https://gitlab.corp.io/team/other.git" }],
    ]);
    const ok = validateGitCredentialBindings(
      [repo("https://jihulab.com/acme/app.git", "c1")],
      templates,
    );
    expect(ok).toEqual([]);
    const bad = validateGitCredentialBindings(
      [repo("https://jihulab.com/acme/app.git", "c2")],
      templates,
    );
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("c2");
    expect(bad[0]).toContain("gitlab.corp.io");
  });

  it("平台级凭证（无 repoUrl）与凭证缺失不校验；.git 后缀/host 大写归一化", () => {
    const templates = new Map([
      ["p1", {}],
      ["p2", { repoUrl: "https://JIHULAB.com/acme/app" }],
    ]);
    expect(
      validateGitCredentialBindings([repo("https://jihulab.com/acme/app.git", "p1")], templates),
    ).toEqual([]);
    expect(
      validateGitCredentialBindings([repo("https://jihulab.com/acme/app.git", "p2")], templates),
    ).toEqual([]);
    expect(
      validateGitCredentialBindings([repo("https://jihulab.com/x/y.git", undefined)], templates),
    ).toEqual([]);
  });
});
