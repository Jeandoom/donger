import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGithubAuthorizeUrl,
  getGithubAccessToken,
  getGithubUser,
} from "../../src/util/github-oauth-api.js";

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("buildGithubAuthorizeUrl", () => {
  it("包含 client_id/redirect_uri/scope/state", () => {
    const url = buildGithubAuthorizeUrl({
      clientId: "cid",
      redirectUri: "https://example.com/api/auth/github/callback",
      state: "s1",
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe("https://example.com/api/auth/github/callback");
    expect(u.searchParams.get("scope")).toBe("read:user");
    expect(u.searchParams.get("state")).toBe("s1");
  });

  it("redirect_uri 含特殊字符时正确编码", () => {
    const url = buildGithubAuthorizeUrl({
      clientId: "cid",
      redirectUri: "https://example.com/cb?a=1&b=2",
      state: "s1",
    });
    expect(url).toContain(encodeURIComponent("https://example.com/cb?a=1&b=2"));
  });
});

describe("getGithubAccessToken", () => {
  it("返回 access_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: "tok", token_type: "bearer" }),
      })),
    );
    expect(await getGithubAccessToken("cid", "secret", "code", "https://example.com/cb")).toBe(
      "tok",
    );
  });

  it("HTTP 200 但 body 带 error → 抛错（GitHub 对无效 code 不返回非 2xx）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            error: "bad_verification_code",
            error_description: "The code passed is incorrect or expired.",
          }),
      })),
    );
    await expect(
      getGithubAccessToken("cid", "secret", "bad", "https://example.com/cb"),
    ).rejects.toThrow(/bad_verification_code/);
  });

  it("响应非 JSON → 抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, text: async () => "<html>bad gateway" })),
    );
    await expect(
      getGithubAccessToken("cid", "secret", "code", "https://example.com/cb"),
    ).rejects.toThrow(/HTTP 502/);
  });
});

describe("getGithubUser", () => {
  it("返回 id/login/name/avatarUrl；name 为 null → undefined", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 583231,
            login: "octocat",
            name: null,
            avatar_url: "https://a/b.png",
          }),
      })),
    );
    const user = await getGithubUser("tok");
    expect(user).toEqual({ id: "583231", login: "octocat", avatarUrl: "https://a/b.png" });
  });

  it("401 → 抛错并带 message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ message: "Bad credentials" }),
      })),
    );
    await expect(getGithubUser("bad")).rejects.toThrow(/Bad credentials/);
  });
});
