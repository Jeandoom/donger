import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as Db } from "better-sqlite3";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { appVersionDir } from "../../src/adapters/app-api.js";
import type { AppApiDeps, AppHttpCtx } from "../../src/adapters/app-api.js";
import { createAppProxyHandler } from "../../src/adapters/app-proxy.js";
import { AppTokenService } from "../../src/adapters/app-token-service.js";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteAppStore } from "../../src/adapters/sqlite-app-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { AppManifestSchema } from "../../src/domain/app.js";

/**
 * 应用分享四档（分发面 spec 2026-09-25-app-platform-architecture §7.2）：
 * private/grants/all-users/public-anonymous × app-token 三 scope（owner/viewer/anonymous）。
 * 每条用例对应一条安全不变量：授权判定、只读收口、撤销语义、防探测口径。
 */

let web: WebChannel | undefined;
let db: Db | undefined;

afterEach(async () => {
  await web?.stop();
  db?.close();
  web = undefined;
  db = undefined;
});

const MANIFEST = {
  manifestVersion: 1 as const,
  runtime: "static" as const,
  ui: { spa: true },
  access: "private" as const,
};

interface Fixture {
  port: number;
  ownerToken: string;
  otherToken: string;
  thirdToken: string;
  ownerId: string;
  otherId: string;
  appId: string;
  appStore: SqliteAppStore;
  appsDir: string;
}

async function setup(): Promise<Fixture> {
  db = new Database(":memory:");
  const tmp = mkdtempSync(join(tmpdir(), "app-share-"));
  const userStore = new SqliteUserStore(db, {
    adminExternalIds: new Set(),
    usersDir: join(tmp, "users"),
  });
  userStore.migrate();
  const owner = await userStore.getOrCreateByIdentity("internal", "share-owner", "属主");
  const other = await userStore.getOrCreateByIdentity("internal", "share-other", "被分享者");
  const third = await userStore.getOrCreateByIdentity("internal", "share-third", "路人");
  const sessionStore = new JwtSessionStore(db, "test-secret");
  sessionStore.migrate();
  const { token: ownerToken } = await sessionStore.create(owner.id);
  const { token: otherToken } = await sessionStore.create(other.id);
  const { token: thirdToken } = await sessionStore.create(third.id);
  const appStore = new SqliteAppStore(db);
  appStore.migrate();
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: join(tmp, "web"),
    userStore,
    sessionStore,
    appStore,
    appsDir: join(tmp, "apps"),
    appTokenSecret: "test-secret",
  });
  web.onMessage(() => {});
  await web.ready();
  const port = web.boundPort;
  if (!port) throw new Error("web server 未启动");

  const app = await appStore.create({
    id: `app_${crypto.randomUUID()}`,
    userId: owner.id,
    name: "监控台",
    description: "测试应用",
    manifest: MANIFEST,
  });
  return {
    port,
    ownerToken,
    otherToken,
    thirdToken,
    ownerId: owner.id,
    otherId: other.id,
    appId: app.id,
    appStore,
    appsDir: join(tmp, "apps"),
  };
}

/** 播种一个已发布版本（未发布应用对被分享者视同不存在） */
async function seedVersion(f: Fixture): Promise<number> {
  const versions = await f.appStore.listVersions(f.appId);
  const num = (versions[0]?.num ?? 0) + 1;
  const dir = appVersionDir(f.appsDir, f.appId, num);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), "<html><body>v1</body></html>");
  const { createHash } = await import("node:crypto");
  await f.appStore.addVersion(f.appId, {
    bundleBytes: 8,
    bundleSha256: createHash("sha256").update("v1").digest("hex"),
    fileCount: 1,
    totalBytes: 8,
    createdAt: new Date().toISOString(),
    createdBy: "seed",
  });
  await f.appStore.publishVersion(f.appId, num);
  return num;
}

/** 属主改分享配置（等价于 web 端分享对话框的 PATCH） */
async function patchShare(
  f: Fixture,
  body: Record<string, unknown>,
  token = f.ownerToken,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function viewerToken(
  f: Fixture,
  token: string | undefined,
): Promise<{ status: number; body: { scope?: string; token?: string; name?: string } }> {
  return fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}/viewer-token`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).then(async (r) => ({
    status: r.status,
    body: (await r.json()) as { scope?: string; token?: string; name?: string },
  }));
}

function anonymousToken(f: Fixture): Promise<{ status: number; body: { token?: string } }> {
  return fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}/anonymous-token`, {
    method: "POST",
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as { token?: string } }));
}

describe("分享面：schema 与存储", () => {
  it("manifest access 放宽为四档；未知值仍显式拒绝", () => {
    for (const access of ["private", "grants", "all-users", "public-anonymous"]) {
      expect(AppManifestSchema.parse({ ...MANIFEST, access }).access).toBe(access);
    }
    expect(() => AppManifestSchema.parse({ ...MANIFEST, access: "everyone" })).toThrow();
  });

  it("listSharedWith：all-users 全量、grants 按名单、private/未发布/自有应用不出现", async () => {
    const f = await setup();
    await f.appStore.update(f.appId, { manifest: { ...MANIFEST, access: "all-users" } });
    // 未发布：即使 all-users 也不进共享列表
    expect((await f.appStore.listSharedWith(f.otherId)).map((a) => a.id)).not.toContain(f.appId);
    await seedVersion(f);
    expect((await f.appStore.listSharedWith(f.otherId)).map((a) => a.id)).toContain(f.appId);
    // 属主自己不进自己的共享列表
    expect((await f.appStore.listSharedWith(f.ownerId)).map((a) => a.id)).not.toContain(f.appId);
    // grants：名单内可见，名单外不可见
    await f.appStore.update(f.appId, {
      manifest: { ...MANIFEST, access: "grants" },
      shareGrants: [f.otherId],
    });
    expect((await f.appStore.listSharedWith(f.otherId)).map((a) => a.id)).toContain(f.appId);
    // private 回退：名单保留但不再可见
    await f.appStore.update(f.appId, { manifest: { ...MANIFEST, access: "private" } });
    expect((await f.appStore.listSharedWith(f.otherId)).map((a) => a.id)).not.toContain(f.appId);
  });
});

describe("分享面：令牌签发授权矩阵", () => {
  it("private：非属主 viewer-token 403、匿名 404；属主经打开页得 owner scope", async () => {
    const f = await setup();
    await seedVersion(f);
    expect((await viewerToken(f, f.otherToken)).status).toBe(403);
    expect((await anonymousToken(f)).status).toBe(404);
    const ownerOpen = await viewerToken(f, f.ownerToken);
    expect(ownerOpen.status).toBe(200);
    expect(ownerOpen.body.scope).toBe("owner");
  });

  it("all-users：任意登录用户得 viewer scope；匿名仍 404", async () => {
    const f = await setup();
    await seedVersion(f);
    await patchShare(f, { manifest: { ...MANIFEST, access: "all-users" } });
    const other = await viewerToken(f, f.otherToken);
    expect(other.status).toBe(200);
    expect(other.body.scope).toBe("viewer");
    expect((await viewerToken(f, f.thirdToken)).status).toBe(200);
    expect((await anonymousToken(f)).status).toBe(404);
  });

  it("grants：名单内得 viewer、名单外 403；移出名单即收回（防探测同 403）", async () => {
    const f = await setup();
    await seedVersion(f);
    await patchShare(f, {
      manifest: { ...MANIFEST, access: "grants" },
      shareGrants: [f.otherId],
    });
    expect((await viewerToken(f, f.otherToken)).body.scope).toBe("viewer");
    expect((await viewerToken(f, f.thirdToken)).status).toBe(403);
    // 撤销：移出名单后再签发被拒（已签发令牌至多活完 60min TTL）
    await patchShare(f, { manifest: { ...MANIFEST, access: "grants" }, shareGrants: [] });
    expect((await viewerToken(f, f.otherToken)).status).toBe(403);
  });

  it("public-anonymous：免登录签发匿名令牌；非名单登录用户仍 403", async () => {
    const f = await setup();
    await seedVersion(f);
    await patchShare(f, { manifest: { ...MANIFEST, access: "public-anonymous" } });
    const anon = await anonymousToken(f);
    expect(anon.status).toBe(200);
    expect(anon.body.token).toBeTruthy();
    expect((await viewerToken(f, f.thirdToken)).status).toBe(403);
  });

  it("未发布应用：all-users 下 viewer-token 与匿名令牌均 404（视同不存在）", async () => {
    const f = await setup();
    await patchShare(f, { manifest: { ...MANIFEST, access: "all-users" } });
    expect((await viewerToken(f, f.otherToken)).status).toBe(404);
    expect((await anonymousToken(f)).status).toBe(404);
  });

  it("GET /api/apps：被分享者拿到 shared 最小视图（无管理面字段）；属主 shared 为空", async () => {
    const f = await setup();
    await seedVersion(f);
    await patchShare(f, { manifest: { ...MANIFEST, access: "grants" }, shareGrants: [f.otherId] });
    const otherList = (await fetch(`http://127.0.0.1:${f.port}/api/apps`, {
      headers: { Authorization: `Bearer ${f.otherToken}` },
    }).then((r) => r.json())) as { apps: unknown[]; shared: Array<Record<string, unknown>> };
    expect(otherList.apps).toHaveLength(0);
    expect(otherList.shared).toHaveLength(1);
    const view = otherList.shared[0]!;
    expect(view.id).toBe(f.appId);
    expect(view.access).toBe("grants");
    expect(view).not.toHaveProperty("proxyChannels");
    expect(view).not.toHaveProperty("steward");
    const ownerList = (await fetch(`http://127.0.0.1:${f.port}/api/apps`, {
      headers: { Authorization: `Bearer ${f.ownerToken}` },
    }).then((r) => r.json())) as { shared: unknown[] };
    expect(ownerList.shared).toHaveLength(0);
  });

  it("越权：非属主 PATCH 分享配置与 grant-candidates 被守卫拒绝（403）", async () => {
    const f = await setup();
    await seedVersion(f);
    // PATCH/grant-candidates 走守卫表 owner(app) 规则：非属主在进入 handler 前即 403
    expect((await patchShare(f, { shareGrants: [f.otherId] }, f.otherToken)).status).toBe(403);
    const cand = await fetch(
      `http://127.0.0.1:${f.port}/api/apps/${f.appId}/grant-candidates?q=`,
      { headers: { Authorization: `Bearer ${f.otherToken}` } },
    );
    expect(cand.status).toBe(403);
    // 属主可搜到候选用户
    const ok = await fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}/grant-candidates?q=`, {
      headers: { Authorization: `Bearer ${f.ownerToken}` },
    });
    expect(ok.status).toBe(200);
    const d = (await ok.json()) as { users: Array<{ id: string }> };
    expect(d.users.map((u) => u.id)).toContain(f.otherId);
  });
});

describe("分享面：运行时只读收口", () => {
  it("viewer 令牌：app-data GET 200 / PUT 403；app-proxy POST 403（在通道解析之前裁定）", async () => {
    const f = await setup();
    await seedVersion(f);
    await patchShare(f, { manifest: { ...MANIFEST, access: "all-users" } });
    const { token } = (await viewerToken(f, f.otherToken)).body as { token: string };
    const auth = { Authorization: `Bearer ${token}` };
    // 属主先经 /token 拿 app-token 写一条数据供只读验证（运行时面不收主 JWT）
    const ownerAppTok = (await fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.ownerToken}` },
    }).then((r) => r.json())) as { token: string };
    const ownerWrite = await fetch(`http://127.0.0.1:${f.port}/api/app-data/${f.appId}/cfg`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerAppTok.token}`,
      },
      body: JSON.stringify({ value: { a: 1 } }),
    });
    expect(ownerWrite.status).toBe(200);
    const get = await fetch(`http://127.0.0.1:${f.port}/api/app-data/${f.appId}/cfg`, { headers: auth });
    expect(get.status).toBe(200);
    const put = await fetch(`http://127.0.0.1:${f.port}/api/app-data/${f.appId}/cfg`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ value: { a: 2 } }),
    });
    expect(put.status).toBe(403);
    // 代理只读：viewer POST 在通道解析前被 403（无需装配连接器）
    const proxy = await createProxyResult(f.appId, token);
    expect(proxy.status).toBe(403);
    // 属主 scope 不受只读限制（未绑定通道走 503 而非 403）
    const ownerOpen = (await viewerToken(f, f.ownerToken)).body as { token: string };
    const ownerProxy = await createProxyResult(f.appId, ownerOpen.token!);
    expect(ownerProxy.status).toBe(503);
  });
});

/** 直连代理 handler 的最小夹具（scope 判定发生在 store/连接器触碰之前） */
async function createProxyResult(appId: string, appToken: string): Promise<{ status: number }> {
  const deps = {
    appStore: new SqliteAppStore(db!),
    appsDir: ".",
    appToken: new AppTokenService("test-secret"),
    connectorStore: { getById: async () => undefined },
    credentialSets: { getFilledValues: async () => [], listValueCodes: async () => [] },
  } as unknown as Parameters<typeof createAppProxyHandler>[0];
  const handler = createAppProxyHandler(deps);
  const ctx = {
    userIdOf: () => undefined,
    roleOf: () => "user",
    // 代理协议的 method 在 body 里（非 HTTP method）：POST 才会触发只读收口
    readBody: async () => JSON.stringify({ path: "/x", method: "POST" }),
  } as unknown as AppHttpCtx;
  const req = {
    headers: { authorization: `Bearer ${appToken}` },
    url: `http://localhost/api/app-proxy/${appId}/svc`,
  } as unknown as Parameters<typeof handler>[1];
  return handler(ctx, req, appId, "svc");
}
