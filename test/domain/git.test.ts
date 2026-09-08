import { describe, expect, it } from "vitest";
import {
  AgentGitRepositoriesSchema,
  gitRepositoryFingerprint,
  inferGitProvider,
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
    expect(gitRepositoryFingerprint(repository)).toBe("github:acme/backend");
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
