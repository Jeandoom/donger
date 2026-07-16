import { describe, expect, it, vi } from "vitest";
import {
  GiteeAuthProvider,
  GitHubAuthProvider,
  JihuLabAuthProvider,
} from "../../src/adapters/git-auth-providers.js";

describe("Git auth providers", () => {
  it.each([
    [GitHubAuthProvider, "github.com/login/oauth/authorize", "repo"],
    [GiteeAuthProvider, "gitee.com/oauth/authorize", "projects"],
    [JihuLabAuthProvider, "jihulab.com/oauth/authorize", "read_repository"],
  ] as const)("生成平台 OAuth 地址", (Provider, hostPath, scope) => {
    const provider = new Provider({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://donger.example/callback",
    });
    const url = provider.getAuthorizationUrl("state-1");
    expect(url).toContain(hostPath);
    expect(url).toContain("state=state-1");
    expect(decodeURIComponent(url)).toContain(scope);
  });

  it("GitHub PAT 验证后返回身份且不改变 token", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ id: 42, login: "alice", avatar_url: "https://avatar" }),
    );
    const provider = new GitHubAuthProvider({}, fetchMock as typeof fetch);
    await expect(provider.verifyPat("pat-token")).resolves.toEqual({
      accountId: "42",
      accountName: "alice",
      avatarUrl: "https://avatar",
      authType: "pat",
      accessToken: "pat-token",
      scopes: [],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer pat-token" }),
      }),
    );
  });

  it("未配置 OAuth 时拒绝生成授权地址", () => {
    expect(() => new GiteeAuthProvider({}).getAuthorizationUrl("state")).toThrow("OAuth 未配置");
  });
});
