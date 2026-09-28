import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppProxyHandlerDeps } from "../../src/adapters/app-proxy.js";
import { createAppProxyHandler } from "../../src/adapters/app-proxy.js";
import { AppTokenService } from "../../src/adapters/app-token-service.js";
import { ValidationError } from "../../src/util/errors.js";

/**
 * app-proxy 受控代理契约测试：鉴权 / service 白名单与配置门 / 路径校验 /
 * 三服务凭证注入（jihulab PRIVATE-TOKEN、jenkins Basic+CRUMB 重试、ops 懒登录+401 重登）。
 * fetch 以 vi.stubGlobal 模拟，不发起真实网络请求。
 */

const SECRET = "test-secret";
const appId = "app_test";

function makeDeps(proxyConfig: AppProxyHandlerDeps["proxyConfig"]): AppProxyHandlerDeps {
  return {
    appStore: {} as AppProxyHandlerDeps["appStore"],
    appsDir: "/tmp/x",
    appToken: new AppTokenService(SECRET),
    proxyConfig,
  };
}

function makeCtx(body: unknown) {
  return {
    userIdOf: () => "u1",
    roleOf: () => "user" as const,
    readBody: async () => JSON.stringify(body),
  };
}

async function call(deps: AppProxyHandlerDeps, body: unknown, service: string, auth?: string) {
  const handle = createAppProxyHandler(deps);
  const token =
    auth ??
    `Bearer ${(await new AppTokenService(SECRET).issue({ userId: "u1", appId, scope: "owner" })).token}`;
  return handle(makeCtx(body), { headers: { authorization: token } } as never, appId, service);
}

afterEach(() => vi.unstubAllGlobals());

describe("app-proxy 鉴权与服务门", () => {
  it("缺 app-token → 401", async () => {
    const r = await call(
      makeDeps({ jihulab: { baseUrl: "https://jh", token: "t" } }),
      { path: "/api/v4/x" },
      "jihulab",
      "Bearer bad",
    );
    expect(r.status).toBe(401);
  });

  it("未知 service → ValidationError；未配置 service → 503", async () => {
    const deps = makeDeps({});
    await expect(call(deps, { path: "/x" }, "evil")).rejects.toThrow(ValidationError);
    const r = await call(deps, { path: "/api/v4/x" }, "jihulab");
    expect(r.status).toBe(503);
  });

  it("path 穿越 / 双斜杠 / 非法字符 → ValidationError", async () => {
    const deps = makeDeps({ jihulab: { baseUrl: "https://jh", token: "t" } });
    for (const path of ["api/v4/x", "/a/../b", "/a//b", "/a?b", "/a b"]) {
      await expect(call(deps, { path }, "jihulab")).rejects.toThrow(ValidationError);
    }
  });
});

describe("app-proxy 凭证注入", () => {
  it("jihulab：注入 PRIVATE-TOKEN，包装上游状态与 JSON 体", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"a":1}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await call(
      makeDeps({ jihulab: { baseUrl: "https://jh.test", token: "glpat-x" } }),
      { path: "/api/v4/projects", query: "per_page=10" },
      "jihulab",
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://jh.test/api/v4/projects?per_page=10");
    expect((init.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("glpat-x");
    expect(r.json).toMatchObject({ status: 200, contentType: "application/json", body: '{"a":1}' });
  });

  it("jenkins POST：Basic Auth，403 → 重取 CRUMB 后重试", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("full authentication required", { status: 403 }))
      .mockResolvedValueOnce(
        new Response('{"crumb":"c1","crumbRequestField":"Jenkins-Crumb"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("", { status: 201, headers: { Location: "http://jk/queue/item/9/" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const r = await call(
      makeDeps({ jenkins: { baseUrl: "http://jk.test", username: "u", apiToken: "tk" } }),
      { path: "/job/AIR/buildWithParameters", query: "branch=master", method: "POST" },
      "jenkins",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const third = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(third[0]).toBe("http://jk.test/job/AIR/buildWithParameters?branch=master");
    const headers = third[1].headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    expect(headers["Jenkins-Crumb"]).toBe("c1");
    expect(r.json).toMatchObject({ status: 201, location: "http://jk/queue/item/9/" });
  });

  it("ops：先登录再请求，401 → 重登一次", async () => {
    const okBody = '{"results":[]}';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"token":"jwt-1"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(
        new Response('{"token":"jwt-2"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(okBody, { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const r = await call(
      makeDeps({ ops: { baseUrl: "https://ops.test", username: "u", password: "p" } }),
      { path: "/api/project/", query: "limit=10" },
      "ops",
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const loginCall = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(loginCall[0]).toBe("https://ops.test/api/token/");
    const retry = fetchMock.mock.calls[3] as [string, RequestInit];
    expect((retry[1].headers as Record<string, string>).Authorization).toBe("BEARER jwt-2");
    expect(r.json).toMatchObject({ status: 200, body: okBody });
  });
});
