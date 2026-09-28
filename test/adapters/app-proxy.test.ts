import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppProxyHandlerDeps } from "../../src/adapters/app-proxy.js";
import { createAppProxyHandler } from "../../src/adapters/app-proxy.js";
import { AppTokenService } from "../../src/adapters/app-token-service.js";
import type { PlatformApp } from "../../src/domain/app.js";
import type { Connector } from "../../src/domain/connector.js";
import { ValidationError } from "../../src/util/errors.js";

/**
 * app-proxy v2 契约测试（spec 2026-09-29-app-proxy-credential-binding）：
 * 鉴权 / 通道解析（未绑定、连接器失效、凭证缺失、缺键）/ 路径校验 /
 * 三认证风格（none 静态头+引用替换、basic-crumb CRUMB 重试、token-login 401 重登）。
 * fetch 以 vi.stubGlobal 模拟，不发起真实网络请求；store 以最小桩注入。
 */

const SECRET = "test-secret";
const appId = "app_test";
const ownerId = "u1";

function makeConnector(over: Partial<Connector> = {}): Connector {
  return {
    id: "conn_1",
    name: "jh",
    type: "http",
    transport: "http",
    url: "https://jh.test",
    headers: {},
    enabled: true,
    shareScope: "private",
    ownerId,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function makeApp(bindings: Record<string, string>): PlatformApp {
  return {
    id: appId,
    userId: ownerId,
    name: "copilot",
    description: "",
    manifest: { manifestVersion: 1, runtime: "static", ui: { spa: true }, access: "private" },
    currentVersion: 1,
    proxyBindings: bindings,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

/** filled: code → 凭证值集（缺失 code = 属主未填该凭证） */
function makeDeps(
  app: PlatformApp | undefined,
  connector: Connector | undefined,
  filled: Record<string, Record<string, string>>,
): AppProxyHandlerDeps {
  return {
    appStore: { get: async () => app } as unknown as AppProxyHandlerDeps["appStore"],
    appsDir: "/tmp/x",
    appToken: new AppTokenService(SECRET),
    connectorStore: {
      getById: async () => connector,
    } as unknown as AppProxyHandlerDeps["connectorStore"],
    credentialSets: {
      getFilledValues: async (_uid: string, codes: string[]) =>
        codes
          .filter((c) => filled[c])
          .map((c) => ({ code: c, values: filled[c] as Record<string, string> })),
    } as AppProxyHandlerDeps["credentialSets"],
  };
}

function makeCtx(body: unknown) {
  return {
    userIdOf: () => ownerId,
    roleOf: () => "user" as const,
    readBody: async () => JSON.stringify(body),
  };
}

async function call(deps: AppProxyHandlerDeps, body: unknown, service: string, auth?: string) {
  const handle = createAppProxyHandler(deps);
  const token =
    auth ??
    `Bearer ${(await new AppTokenService(SECRET).issue({ userId: ownerId, appId, scope: "owner" })).token}`;
  return handle(makeCtx(body), { headers: { authorization: token } } as never, appId, service);
}

afterEach(() => vi.unstubAllGlobals());

describe("app-proxy 鉴权与通道解析", () => {
  it("缺 app-token → 401", async () => {
    const deps = makeDeps(makeApp({ jihulab: "conn_1" }), makeConnector(), {
      jh: { access_token: "t" },
    });
    const r = await call(deps, { path: "/api/v4/x" }, "jihulab", "Bearer bad");
    expect(r.status).toBe(401);
  });

  it("应用不存在 / 服务未绑定 → 503 带原因", async () => {
    const r1 = await call(makeDeps(undefined, makeConnector(), {}), { path: "/x" }, "jihulab");
    expect(r1.status).toBe(503);
    expect(String((r1.json as { error: string }).error)).toContain("应用不存在");
    const r2 = await call(makeDeps(makeApp({}), makeConnector(), {}), { path: "/x" }, "jihulab");
    expect(r2.status).toBe(503);
    expect(String((r2.json as { error: string }).error)).toContain("未绑定出网通道");
  });

  it("连接器删除/停用/非 http/他人私有 → 503 通道不可用", async () => {
    const app = makeApp({ svc: "conn_1" });
    const cases: Array<Connector | undefined> = [
      undefined,
      makeConnector({ enabled: false }),
      makeConnector({ type: "mcp" }),
      makeConnector({ ownerId: "someone-else", shareScope: "private" }),
    ];
    for (const connector of cases) {
      const r = await call(makeDeps(app, connector, {}), { path: "/x" }, "svc");
      expect(r.status).toBe(503);
      expect(String((r.json as { error: string }).error)).toContain("通道不可用");
    }
  });

  it("凭证未填 / 风格必需键缺失 → 503 指路凭证页", async () => {
    const app = makeApp({ svc: "conn_1" });
    // headers 引用 jh 凭证但属主未填
    const c1 = makeConnector({ headers: { "PRIVATE-TOKEN": "{{credential:jh.access_token}}" } });
    const r1 = await call(makeDeps(app, c1, {}), { path: "/x" }, "svc");
    expect(r1.status).toBe(503);
    expect(String((r1.json as { error: string }).error)).toContain("凭证未填写：jh");
    // basic-crumb 缺 apiToken 键
    const c2 = makeConnector({
      auth: { style: "basic-crumb", credential: "jk" },
    });
    const r2 = await call(makeDeps(app, c2, { jk: { username: "u" } }), { path: "/x" }, "svc");
    expect(r2.status).toBe(503);
    expect(String((r2.json as { error: string }).error)).toContain("缺键 apiToken");
  });

  it("path 穿越 / 双斜杠 / 非法字符 → ValidationError；Jenkins tree 裸方括号放行", async () => {
    const app = makeApp({ jihulab: "conn_1" });
    const deps = makeDeps(app, makeConnector(), { jh: { access_token: "t" } });
    for (const path of ["api/v4/x", "/a/../b", "/a//b", "/a?b", "/a b"]) {
      await expect(call(deps, { path }, "jihulab")).rejects.toThrow(ValidationError);
    }
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })),
    );
    await expect(
      call(deps, { path: "/api/json", query: "tree=jobs[name,color]" }, "jihulab"),
    ).resolves.toMatchObject({ status: 200 });
  });
});

describe("app-proxy 认证风格", () => {
  it("none：headers 静态头 + 凭证引用替换（jihulab PRIVATE-TOKEN），包装上游响应", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"a":1}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const deps = makeDeps(
      makeApp({ jihulab: "conn_1" }),
      makeConnector({
        headers: { "PRIVATE-TOKEN": "{{credential:jh.access_token}}" },
      }),
      { jh: { access_token: "glpat-x" } },
    );
    const r = await call(deps, { path: "/api/v4/projects", query: "per_page=10" }, "jihulab");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://jh.test/api/v4/projects?per_page=10");
    expect((init.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("glpat-x");
    expect(r.json).toMatchObject({ status: 200, contentType: "application/json", body: '{"a":1}' });
  });

  it("basic-crumb：POST Basic 认证，403 → 重取 CRUMB 后重试", async () => {
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
    const deps = makeDeps(
      makeApp({ jenkins: "conn_1" }),
      makeConnector({
        url: "http://jk.test",
        auth: { style: "basic-crumb", credential: "jk" },
      }),
      { jk: { username: "u", apiToken: "tk" } },
    );
    const r = await call(
      deps,
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

  it("token-login：先登录再请求，401 → 重登一次", async () => {
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
    const deps = makeDeps(
      makeApp({ ops: "conn_1" }),
      makeConnector({
        url: "https://ops.test",
        auth: { style: "token-login", credential: "ops" },
      }),
      { ops: { username: "u", password: "p" } },
    );
    const r = await call(deps, { path: "/api/project/", query: "limit=10" }, "ops");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const loginCall = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(loginCall[0]).toBe("https://ops.test/api/token/");
    const retry = fetchMock.mock.calls[3] as [string, RequestInit];
    expect((retry[1].headers as Record<string, string>).Authorization).toBe("BEARER jwt-2");
    expect(r.json).toMatchObject({ status: 200, body: okBody });
  });
});
