import { describe, expect, it } from "vitest";
import type { AppApiDeps } from "../../src/adapters/app-api.js";
import { handlePatchApp } from "../../src/adapters/app-api.js";
import { AppTokenService } from "../../src/adapters/app-token-service.js";
import type { PlatformApp } from "../../src/domain/app.js";
import type { Connector } from "../../src/domain/connector.js";
import { ValidationError } from "../../src/util/errors.js";

/**
 * 出网通道 API 契约（spec 2026-09-29-app-proxy-credential-binding §2.2/§3）：
 * PATCH proxyBindings 写入口校验矩阵 + appView 通道状态 DTO（ready/credential-missing/unavailable）。
 */

const ownerId = "u1";
const appId = "app_ch";

function makeApp(bindings?: Record<string, string>): PlatformApp {
  return {
    id: appId,
    userId: ownerId,
    name: "copilot",
    description: "",
    manifest: { manifestVersion: 1, runtime: "static", ui: { spa: true }, access: "private" },
    currentVersion: null,
    proxyBindings: bindings,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function makeConnector(over: Partial<Connector> = {}): Connector {
  return {
    id: "conn_1",
    name: "jh",
    type: "http",
    transport: "http",
    url: "https://jh.test",
    headers: { "PRIVATE-TOKEN": "{{credential:jh.access_token}}" },
    enabled: true,
    shareScope: "private",
    ownerId,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function makeDeps(
  app: PlatformApp,
  connectors: Record<string, Connector>,
  filledCodes: string[],
): AppApiDeps {
  return {
    appStore: {
      get: async () => app,
      update: async (_id: string, patch: Partial<PlatformApp>) => ({ ...app, ...patch }),
    } as unknown as AppApiDeps["appStore"],
    appsDir: "/tmp/x",
    appToken: new AppTokenService("test-secret"),
    connectorStore: {
      getById: async (id: string) => connectors[id],
    } as unknown as AppApiDeps["connectorStore"],
    credentialSets: {
      listValueCodes: async () => filledCodes,
    } as unknown as AppApiDeps["credentialSets"],
  };
}

const ctx = {
  userIdOf: () => ownerId,
  roleOf: () => "user" as const,
  readBody: async () => "",
};

function patch(deps: AppApiDeps, body: unknown) {
  return handlePatchApp(
    { ...ctx, readBody: async () => JSON.stringify(body) },
    deps,
    { headers: {} } as never,
    appId,
  );
}

describe("PATCH proxyBindings 写入口校验", () => {
  it("合法绑定 → 200 且 DTO 通道 ready", async () => {
    const deps = makeDeps(makeApp(), { conn_1: makeConnector() }, ["jh"]);
    const r = await patch(deps, { proxyBindings: { jihulab: "conn_1" } });
    expect(r.status).toBe(200);
    const channels = (r.json as { app: { proxyChannels: Array<Record<string, unknown>> } }).app
      .proxyChannels;
    expect(channels).toEqual([
      {
        service: "jihulab",
        connectorId: "conn_1",
        connectorName: "jh",
        authStyle: "none",
        status: "ready",
        missingCredentials: [],
      },
    ]);
  });

  it("他人私有/不存在连接器 → 400；type=mcp → 400；停用 → 400", async () => {
    const connectors = {
      other: makeConnector({ id: "other", ownerId: "someone-else" }),
      mcp: makeConnector({ id: "mcp", type: "mcp" }),
      off: makeConnector({ id: "off", enabled: false }),
    };
    const deps = makeDeps(makeApp(), connectors, []);
    await expect(patch(deps, { proxyBindings: { a: "other" } })).rejects.toThrow(ValidationError);
    await expect(patch(deps, { proxyBindings: { a: "mcp" } })).rejects.toThrow(/type=http/);
    await expect(patch(deps, { proxyBindings: { a: "off" } })).rejects.toThrow(/停用/);
    await expect(patch(deps, { proxyBindings: { a: "missing" } })).rejects.toThrow(ValidationError);
  });

  it("global 连接器可被他人应用勾选；DTO 状态区分凭证未填与失效", async () => {
    const globalConn = makeConnector({ ownerId: "creator", shareScope: "global" });
    const deps = makeDeps(makeApp(), { g: globalConn }, []);
    const r = await patch(deps, { proxyBindings: { jihulab: "g" } });
    expect(r.status).toBe(200);
    const channels = (
      r.json as { app: { proxyChannels: Array<{ status: string; missingCredentials: string[] }> } }
    ).app.proxyChannels;
    expect(channels[0]?.status).toBe("credential-missing");
    expect(channels[0]?.missingCredentials).toEqual(["jh"]);

    // 通道绑定后连接器被删 → DTO unavailable（读时降级，不炸列表）
    const depsGone = makeDeps(makeApp({ jihulab: "gone" }), {}, []);
    const r2 = await patch(depsGone, { description: "触碰" });
    expect(r2.status).toBe(200);
    expect(
      (r2.json as { app: { proxyChannels: Array<{ status: string }> } }).app.proxyChannels[0]
        ?.status,
    ).toBe("unavailable");
  });
});
