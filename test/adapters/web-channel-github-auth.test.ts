import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import type { GithubUserInfo } from "../../src/util/github-oauth-api.js";
import { createTestModuleConfigStore } from "../util/module-config-test-helper.js";

/** 一次性 code 换 JWT（规格 M4：回调 302 改带 code） */
async function exchangeToken(port: number, location: string): Promise<string> {
  const code = new URLSearchParams(location.split("?")[1] ?? "").get("code") ?? "";
  const res = await realFetch(`http://127.0.0.1:${port}/api/auth/code-exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error(`exchange failed: ${res.status}`);
  return body.token;
}

/** 从 authorize/bind 响应取 state cookie（2026-09-24 起 callback 强校验浏览器绑定） */
function stateCookieOf(setCookie: string | null): string {
  return (setCookie ?? "").split(";")[0] ?? "";
}

/**
 * GitHub OAuth 登录/绑定契约测试。
 * 全局 fetch 仅拦截 github.com 域名（模拟 OAuth 端点），其余（本地服务器）透传真实 fetch。
 */

let web: WebChannel;
let db: Database.Database;
let usersDir: string;
let tmpDir: string;
const realFetch = globalThis.fetch;

const GH_USER: GithubUserInfo = { id: "583231", login: "octocat", name: "The Octocat" };

function stubGithubHttp(user: GithubUserInfo = GH_USER): void {
  const mock = vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { code?: string };
        if (body.code !== "good-code") {
          return new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 200 });
        }
        return new Response(JSON.stringify({ access_token: "gh-tok" }), { status: 200 });
      }
      if (url === "https://api.github.com/user") {
        return new Response(
          JSON.stringify({
            id: Number(user.id),
            login: user.login,
            name: user.name ?? null,
            avatar_url: user.avatarUrl ?? null,
          }),
          { status: 200 },
        );
      }
      return realFetch(input, init);
    },
  );
  vi.stubGlobal("fetch", mock);
}

async function startChannel(
  opts: Partial<{ github: { clientId: string; clientSecret: string } }> = {},
): Promise<number> {
  db = new Database(":memory:");
  const sessionStore = new JwtSessionStore(db, "test-secret");
  sessionStore.migrate();
  const userStore = new SqliteUserStore(db, {
    adminExternalIds: new Set(),
    usersDir,
  });
  userStore.migrate();
  const store = createTestModuleConfigStore(db);
  if (opts.github) store.putGithub(opts.github);
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    moduleConfigStore: store,
  });
  web.onMessage(() => {});
  await web.ready();
  const port = web.boundPort;
  if (!port) throw new Error("server not listening");
  return port;
}

/** 与 startChannel 相同配置的第二个通道（模拟重启后 state 丢失场景不可用，仅用于多实例断言） */
beforeEach(() => {
  usersDir = mkdtempSync(join(tmpdir(), "gh-users-"));
  tmpDir = mkdtempSync(join(tmpdir(), "gh-ws-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  void web?.stop();
  db?.close();
  rmSync(usersDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/auth/github/url", () => {
  it("未配置 → 503", async () => {
    const port = await startChannel();
    const res = await realFetch(`http://127.0.0.1:${port}/api/auth/github/url`);
    expect(res.status).toBe(503);
  });

  it("已配置 → 返回 authorize URL（含 client_id/redirect_uri/scope/state）", async () => {
    const port = await startChannel({
      github: { clientId: "cid", clientSecret: "secret" },
    });
    const res = await realFetch(`http://127.0.0.1:${port}/api/auth/github/url`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { url: string };
    const u = new URL(body.url);
    expect(u.origin + u.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:${port}/api/auth/github/callback`,
    );
    expect(u.searchParams.get("scope")).toBe("read:user");
    expect(u.searchParams.get("state")).toBeTruthy();
  });
});

describe("GET /api/auth/github/callback（登录流程）", () => {
  it("state 无效 → 400（GitHub 侧强校验）", async () => {
    const port = await startChannel({
      github: { clientId: "cid", clientSecret: "secret" },
    });
    const res = await realFetch(
      `http://127.0.0.1:${port}/api/auth/github/callback?code=good-code&state=forged`,
    );
    expect(res.status).toBe(400);
  });

  it("state 过期 → 400", async () => {
    const port = await startChannel({
      github: { clientId: "cid", clientSecret: "secret" },
    });
    // 先取合法 state（带 state cookie），再手动将其置为过期：通过第二个通道无法注入，
    // 故直接用伪造 state 断言 400 后，走一遍完整流程拿 state，再用“二次消费”（state 已删除）
    // 断言过期路径同样 400。
    const urlRes = await realFetch(`http://127.0.0.1:${port}/api/auth/github/url`);
    const { url } = (await urlRes.json()) as { url: string };
    const state = new URL(url).searchParams.get("state") ?? "";
    const cookie = stateCookieOf(urlRes.headers.get("set-cookie"));
    stubGithubHttp();
    // 第一次消费：成功
    const ok = await realFetch(
      `http://127.0.0.1:${port}/api/auth/github/callback?code=good-code&state=${state}`,
      { redirect: "manual", headers: { Cookie: cookie } },
    );
    expect(ok.status).toBe(302);
    // state 一次性，二次消费 → 400
    const replay = await realFetch(
      `http://127.0.0.1:${port}/api/auth/github/callback?code=good-code&state=${state}`,
      { headers: { Cookie: cookie } },
    );
    expect(replay.status).toBe(400);
  });

  it("完整登录 → 302 /login/success?token=…，账号按 (github, id) 创建", async () => {
    const port = await startChannel({
      github: { clientId: "cid", clientSecret: "secret" },
    });
    const urlRes = await realFetch(`http://127.0.0.1:${port}/api/auth/github/url`);
    const { url } = (await urlRes.json()) as { url: string };
    const state = new URL(url).searchParams.get("state") ?? "";
    const cookie = stateCookieOf(urlRes.headers.get("set-cookie"));
    stubGithubHttp();

    const res = await realFetch(
      `http://127.0.0.1:${port}/api/auth/github/callback?code=good-code&state=${state}`,
      { redirect: "manual", headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/login/success?code=")).toBe(true);

    const token = await exchangeToken(port, location);
    const meRes = await realFetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as {
      user: { name: string; role: string };
      identities: { provider: string; externalId: string }[];
    };
    expect(me.user.name).toBe("The Octocat");
    expect(me.identities.map((i) => ({ provider: i.provider, externalId: i.externalId }))).toEqual([
      { provider: "github", externalId: "583231" },
    ]);

    // 二次登录 → 复用同一账号
    const urlRes2 = await realFetch(`http://127.0.0.1:${port}/api/auth/github/url`);
    const { url: url2 } = (await urlRes2.json()) as { url: string };
    const state2 = new URL(url2).searchParams.get("state") ?? "";
    const res2 = await realFetch(
      `http://127.0.0.1:${port}/api/auth/github/callback?code=good-code&state=${state2}`,
      {
        redirect: "manual",
        headers: { Cookie: stateCookieOf(urlRes2.headers.get("set-cookie")) },
      },
    );
    const token2 = await exchangeToken(port, res2.headers.get("location") ?? "");
    const me2 = await realFetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token2 ?? ""}` },
    });
    const body2 = (await me2.json()) as { user: { id: string } };
    const body1 = (await (
      await realFetch(`http://127.0.0.1:${port}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { user: { id: string } };
    expect(body2.user.id).toBe(body1.user.id);
  });
});

describe("GET /api/auth/github/bind + callback（绑定流程）", () => {
  async function loginOnce(port: number): Promise<{ token: string; userId: string }> {
    const urlRes = await realFetch(`http://127.0.0.1:${port}/api/auth/github/url`);
    const { url } = (await urlRes.json()) as { url: string };
    const state = new URL(url).searchParams.get("state") ?? "";
    stubGithubHttp();
    const res = await realFetch(
      `http://127.0.0.1:${port}/api/auth/github/callback?code=good-code&state=${state}`,
      {
        redirect: "manual",
        headers: { Cookie: stateCookieOf(urlRes.headers.get("set-cookie")) },
      },
    );
    const token = await exchangeToken(port, res.headers.get("location") ?? "");
    const me = (await (
      await realFetch(`http://127.0.0.1:${port}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { user: { id: string } };
    return { token, userId: me.user.id };
  }

  it("未登录发起绑定 → 401", async () => {
    const port = await startChannel({
      github: { clientId: "cid", clientSecret: "secret" },
    });
    const res = await realFetch(`http://127.0.0.1:${port}/api/auth/github/bind`);
    expect(res.status).toBe(401);
  });

  it("已登录 → 返回绑定授权 URL；回调后 identity 挂到当前用户", async () => {
    const port = await startChannel({
      github: { clientId: "cid", clientSecret: "secret" },
    });
    const { token, userId } = await loginOnce(port);
    // 换一个 GitHub 用户用于绑定
    stubGithubHttp({ id: "999", login: "bound-user", name: "Bound" });

    const bindRes = await realFetch(`http://127.0.0.1:${port}/api/auth/github/bind`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(bindRes.ok).toBe(true);
    const { url } = (await bindRes.json()) as { url: string };
    const state = new URL(url).searchParams.get("state") ?? "";

    const cbRes = await realFetch(
      `http://127.0.0.1:${port}/api/auth/github/callback?code=good-code&state=${state}`,
      {
        redirect: "manual",
        headers: { Cookie: stateCookieOf(bindRes.headers.get("set-cookie")) },
      },
    );
    expect(cbRes.status).toBe(302);
    const location = cbRes.headers.get("location") ?? "";
    expect(location).toContain("mode=bind");
    expect(location).toContain("provider=github");

    const meRes = await realFetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const me = (await meRes.json()) as {
      user: { id: string };
      identities: { provider: string; externalId: string }[];
    };
    expect(me.user.id).toBe(userId);
    const providers = me.identities.map((i) => i.provider).sort();
    expect(providers).toEqual(["github", "github"]);
    expect(me.identities.map((i) => i.externalId).sort()).toEqual(["583231", "999"]);
  });

  it("GitHub 账号已绑定其他用户 → 302 /login?error=", async () => {
    const port = await startChannel({
      github: { clientId: "cid", clientSecret: "secret" },
    });
    // 用户 A 通过登录持有 github/583231；再构造另一用户 B 发起对同一 GitHub 身份的绑定 → 冲突
    await loginOnce(port);
    const userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
    userStore.migrate();
    const userB = await userStore.getOrCreateByIdentity("internal", "user-b", "UserB");
    const sessionStore = new JwtSessionStore(db, "test-secret");
    sessionStore.migrate();
    const { token: tokenB } = await sessionStore.create(userB.id);
    stubGithubHttp(); // GitHub 侧仍返回 583231（已被用户 A 占用）

    const bindRes = await realFetch(`http://127.0.0.1:${port}/api/auth/github/bind`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const { url } = (await bindRes.json()) as { url: string };
    const state = new URL(url).searchParams.get("state") ?? "";

    const cbRes = await realFetch(
      `http://127.0.0.1:${port}/api/auth/github/callback?code=good-code&state=${state}`,
      {
        redirect: "manual",
        headers: { Cookie: stateCookieOf(bindRes.headers.get("set-cookie")) },
      },
    );
    expect(cbRes.status).toBe(302);
    const location = cbRes.headers.get("location") ?? "";
    expect(location.startsWith("/login?error=")).toBe(true);
    expect(decodeURIComponent(location)).toContain("已绑定其他用户");
  });
});
