import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as Db } from "better-sqlite3";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { appVersionDir } from "../../src/adapters/app-api.js";
import { AppTokenService } from "../../src/adapters/app-token-service.js";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteAppStore } from "../../src/adapters/sqlite-app-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";

/**
 * 应用内核（M1）集成回归：发布 → 静态挂载 → app-token 运行时数据面。
 * 版本播种走 store（zip 上传 HTTP 通道已移除——发布唯一入口=会话智能体，spec 修订 2026-09-26）。
 * 每条用例对应 spec 2026-09-25-app-platform-architecture 的安全不变量。
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
  appId: string;
  appStore: SqliteAppStore;
  appsDir: string;
}

async function setup(): Promise<Fixture> {
  db = new Database(":memory:");
  const tmp = mkdtempSync(join(tmpdir(), "app-runtime-"));
  const userStore = new SqliteUserStore(db, {
    adminExternalIds: new Set(),
    usersDir: join(tmp, "users"),
  });
  userStore.migrate();
  const owner = await userStore.getOrCreateByIdentity("internal", "app-owner", "属主");
  const other = await userStore.getOrCreateByIdentity("internal", "app-other", "路人");
  const sessionStore = new JwtSessionStore(db, "test-secret");
  sessionStore.migrate();
  const { token: ownerToken } = await sessionStore.create(owner.id);
  const { token: otherToken } = await sessionStore.create(other.id);
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

  // 应用壳改由智能体工具创建（HTTP create 已移除）；测试直接走 store
  const app = await appStore.create({
    id: `app_${crypto.randomUUID()}`,
    userId: owner.id,
    name: "监控台",
    description: "测试应用",
    manifest: MANIFEST,
  });
  return { port, ownerToken, otherToken, appId: app.id, appStore, appsDir: join(tmp, "apps") };
}

/** 播种一个已发布版本（等价于智能体 app_deploy 的产物落位） */
async function seedVersion(f: Fixture, html: string): Promise<number> {
  const versions = await f.appStore.listVersions(f.appId);
  const num = (versions[0]?.num ?? 0) + 1;
  const dir = appVersionDir(f.appsDir, f.appId, num);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), `<html><body>${html}</body></html>`);
  writeFileSync(join(dir, "app.js"), `console.log('${html}')`);
  const { createHash } = await import("node:crypto");
  await f.appStore.addVersion(f.appId, {
    bundleBytes: html.length,
    bundleSha256: createHash("sha256").update(html).digest("hex"),
    fileCount: 2,
    totalBytes: html.length * 2,
    createdAt: new Date().toISOString(),
    createdBy: "seed",
  });
  await f.appStore.publishVersion(f.appId, num);
  return num;
}

describe("应用内核：发布-运行闭环", () => {
  it("静态挂载：HTML 带 CSP sandbox 且无 XFO；资产与 SPA fallback 正常", async () => {
    const f = await setup();
    await seedVersion(f, "app-v1");
    const index = await fetch(`http://127.0.0.1:${f.port}/apps/${f.appId}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("app-v1");
    expect(index.headers.get("content-type")).toContain("text/html");
    const csp = index.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(index.headers.get("x-frame-options")).toBeNull();

    const asset = await fetch(`http://127.0.0.1:${f.port}/apps/${f.appId}/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");

    // hash 资产缺失保持 404（不走 SPA fallback）；无扩展名路径 fallback index.html
    expect((await fetch(`http://127.0.0.1:${f.port}/apps/${f.appId}/missing.js`)).status).toBe(404);
    const spa = await fetch(`http://127.0.0.1:${f.port}/apps/${f.appId}/some/route`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("app-v1");
  });

  it("未发布应用静态访问 404；穿越路径被拒绝", async () => {
    const f = await setup();
    expect((await fetch(`http://127.0.0.1:${f.port}/apps/${f.appId}/`)).status).toBe(404);
    await seedVersion(f, "v1");
    // 编码点段（单段含编码斜杠）：客户端不归一化，服务端解码后命中穿越防御
    const trav1 = await fetch(`http://127.0.0.1:${f.port}/apps/${f.appId}/%2E%2E%2Fsecret.txt`);
    expect(trav1.status).toBe(404);
    const trav2 = await fetch(`http://127.0.0.1:${f.port}/apps/${f.appId}/..%2F..%2Fsecret.txt`);
    expect(trav2.status).toBe(404);
  });

  it("静态响应带 ACAO（沙箱 module 加载前提）且 HTML 注入日志采集脚本", async () => {
    const f = await setup();
    await seedVersion(f, "v1");
    const index = await fetch(`http://127.0.0.1:${f.port}/apps/${f.appId}/`);
    expect(index.headers.get("access-control-allow-origin")).toBe("*");
    const html = await index.text();
    expect(html).toContain("__dongerAppLogs");
    expect(html).toContain(f.appId);
    const asset = await fetch(`http://127.0.0.1:${f.port}/apps/${f.appId}/app.js`);
    expect(asset.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("应用日志：网关埋点 + 前端采集 + 属主查询 + 越权拒绝", async () => {
    const f = await setup();
    await seedVersion(f, "v1");
    // 触发网关面：页面加载（info）+ 缺失资产（error）+ 数据 API（info）
    await fetch(`http://127.0.0.1:${f.port}/apps/${f.appId}/`);
    await fetch(`http://127.0.0.1:${f.port}/apps/${f.appId}/missing.js`);
    const issue = await fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.ownerToken}` },
    });
    const { token: appToken } = (await issue.json()) as { token: string };
    await fetch(`http://127.0.0.1:${f.port}/api/app-data/${f.appId}/prefs`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ value: 1 }),
    });

    // 前端面采集（sendBeacon 形态：?token= + text/plain body）
    const ingest = await fetch(
      `http://127.0.0.1:${f.port}/api/app-logs/${f.appId}?token=${encodeURIComponent(appToken)}`,
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ entries: [{ level: "error", message: "boom: renderer crashed" }] }),
      },
    );
    expect(ingest.status).toBe(200);

    // 无效 token 401；超量 400
    const bad = await fetch(`http://127.0.0.1:${f.port}/api/app-logs/${f.appId}?token=bad`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ entries: [{ message: "x" }] }),
    });
    expect(bad.status).toBe(401);
    const tooMany = await fetch(`http://127.0.0.1:${f.port}/api/app-logs/${f.appId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: Array.from({ length: 51 }, (_, i) => ({ message: `m${i}` })),
      }),
    });
    expect(tooMany.status).toBe(400);

    // 属主查询：两类来源都在；404 资产与前端 error 有痕
    const logs = await fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}/logs`, {
      headers: { Authorization: `Bearer ${f.ownerToken}` },
    });
    expect(logs.status).toBe(200);
    const body = (await logs.json()) as { items: AppLogItem[] };
    const srcs = new Set(body.items.map((i) => i.source));
    expect(srcs.has("gateway")).toBe(true);
    expect(srcs.has("frontend")).toBe(true);
    expect(body.items.some((i) => i.path?.endsWith("/missing.js") && i.status === 404)).toBe(true);
    expect(body.items.some((i) => i.message?.includes("boom"))).toBe(true);

    // 越权：非属主 403；未登录 401
    expect(
      (
        await fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}/logs`, {
          headers: { Authorization: `Bearer ${f.otherToken}` },
        })
      ).status,
    ).toBe(403);
    expect((await fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}/logs`)).status).toBe(401);
  });

  it("版本历史与回滚：发布 v2 后可切回 v1", async () => {
    const f = await setup();
    await seedVersion(f, "v1");
    await seedVersion(f, "v2");
    expect(await (await fetch(`http://127.0.0.1:${f.port}/apps/${f.appId}/`)).text()).toContain(
      "v2",
    );

    const rollback = await fetch(
      `http://127.0.0.1:${f.port}/api/apps/${f.appId}/versions/1/publish`,
      { method: "POST", headers: { Authorization: `Bearer ${f.ownerToken}` } },
    );
    expect(rollback.status).toBe(200);
    expect(
      ((await rollback.json()) as { app: { currentVersion: number } }).app.currentVersion,
    ).toBe(1);
    expect(await (await fetch(`http://127.0.0.1:${f.port}/apps/${f.appId}/`)).text()).toContain(
      "v1",
    );
  });

  it("app-token 签发 → 运行时数据面读写删（CORS 面开放）", async () => {
    const f = await setup();
    await seedVersion(f, "v1");
    const issue = await fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.ownerToken}` },
    });
    expect(issue.status).toBe(200);
    const { token: appToken } = (await issue.json()) as { token: string };

    // 主 JWT 在运行时面不被接受（app-token 专属）
    const mainJwtProbe = await fetch(`http://127.0.0.1:${f.port}/api/app-data/${f.appId}/prefs`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${f.ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ value: { a: 1 } }),
    });
    expect(mainJwtProbe.status).toBe(401);

    const put = await fetch(`http://127.0.0.1:${f.port}/api/app-data/${f.appId}/prefs`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ value: { threshold: 5 } }),
    });
    expect(put.status).toBe(200);
    expect(put.headers.get("access-control-allow-origin")).toBe("*");

    const get = await fetch(`http://127.0.0.1:${f.port}/api/app-data/${f.appId}/prefs`, {
      headers: { Authorization: `Bearer ${appToken}` },
    });
    expect(get.status).toBe(200);
    expect(((await get.json()) as { valueJson: string }).valueJson).toBe('{"threshold":5}');

    // 属主数据浏览器（主 JWT 面）
    const list = await fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}/data`, {
      headers: { Authorization: `Bearer ${f.ownerToken}` },
    });
    const listBody = (await list.json()) as { items: Array<{ key: string }>; totalBytes: number };
    expect(listBody.items.map((i) => i.key)).toEqual(["prefs"]);
    expect(listBody.totalBytes).toBeGreaterThan(0);

    // OPTIONS 预检（sandbox iframe 不透明源跨源请求）
    const preflight = await fetch(`http://127.0.0.1:${f.port}/api/app-data/${f.appId}/prefs`, {
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");

    const del = await fetch(`http://127.0.0.1:${f.port}/api/app-data/${f.appId}/prefs`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${appToken}` },
    });
    expect(del.status).toBe(200);
    expect(
      (
        await fetch(`http://127.0.0.1:${f.port}/api/app-data/${f.appId}/prefs`, {
          headers: { Authorization: `Bearer ${appToken}` },
        })
      ).status,
    ).toBe(404);
  });

  it("app-token 与主会话 JWT 密钥空间隔离（不可互逆兑换）", async () => {
    const f = await setup();
    const issue = await fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.ownerToken}` },
    });
    const { token: appToken } = (await issue.json()) as { token: string };

    // app-token 冒充主会话：session 校验必须拒绝（否则等于泄漏完整身份）
    const sessionProbe = await fetch(`http://127.0.0.1:${f.port}/api/auth/me`, {
      headers: { Authorization: `Bearer ${appToken}` },
    });
    expect(sessionProbe.status).toBe(401);

    // 过期 app-token 拒绝
    const shortLived = new AppTokenService("test-secret", 1);
    const { token: stale } = await shortLived.issue({
      userId: "u",
      appId: f.appId,
      scope: "owner",
    });
    await new Promise((r) => setTimeout(r, 1100));
    const staleGet = await fetch(`http://127.0.0.1:${f.port}/api/app-data/${f.appId}/k`, {
      headers: { Authorization: `Bearer ${stale}` },
    });
    expect(staleGet.status).toBe(401);
  });

  it("越权防护：非属主 403（owner 守卫惯例），未登录 401", async () => {
    const f = await setup();
    const forbidden = await fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}`, {
      headers: { Authorization: `Bearer ${f.otherToken}` },
    });
    expect(forbidden.status).toBe(403);
    const tokenSteal = await fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.otherToken}` },
    });
    expect(tokenSteal.status).toBe(403);
    const anon = await fetch(`http://127.0.0.1:${f.port}/api/apps`);
    expect(anon.status).toBe(401);
  });

  it("运行时面数据配额：超大 value 413", async () => {
    const f = await setup();
    const issue = await fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.ownerToken}` },
    });
    const { token: appToken } = (await issue.json()) as { token: string };
    const big = await fetch(`http://127.0.0.1:${f.port}/api/app-data/${f.appId}/big`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(260 * 1024) }),
    });
    expect(big.status).toBe(413);
  });

  it("删除应用级联清理产物目录；zip 上传通道已关闭（404）", async () => {
    const f = await setup();
    await seedVersion(f, "v1");
    // 已移除的上传通道：守卫表不再登记，未登录也是 404（fail-closed）
    const uploadProbe = await fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}/versions`, {
      method: "POST",
    });
    expect(uploadProbe.status).toBe(404);
    const createProbe = await fetch(`http://127.0.0.1:${f.port}/api/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(createProbe.status).toBe(404);

    const del = await fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${f.ownerToken}` },
    });
    expect(del.status).toBe(200);
    expect(
      (
        await fetch(`http://127.0.0.1:${f.port}/api/apps/${f.appId}`, {
          headers: { Authorization: `Bearer ${f.ownerToken}` },
        })
      ).status,
    ).toBe(404);
    expect((await fetch(`http://127.0.0.1:${f.port}/apps/${f.appId}/`)).status).toBe(404);
  });

  it("主站 SPA 路由 /apps 不被网关劫持（无 app_ 前缀走静态兜底）", async () => {
    const f = await setup();
    const res = await fetch(`http://127.0.0.1:${f.port}/apps`);
    // 无 dist 的测试环境返回 404/无 SPA，但绝不能是 400（网关误拦）
    expect(res.status).not.toBe(400);
  });
});
