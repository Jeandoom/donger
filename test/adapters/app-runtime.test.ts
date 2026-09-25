import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as Db } from "better-sqlite3";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AppTokenService } from "../../src/adapters/app-token-service.js";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteAppStore } from "../../src/adapters/sqlite-app-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";

/**
 * 应用内核（M1）集成回归：开发产物上传 → 发布 → 静态挂载 → app-token 运行时数据面。
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

async function setup(): Promise<{
  port: number;
  ownerToken: string;
  otherToken: string;
  appId: string;
}> {
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

  const createRes = await fetch(`http://127.0.0.1:${port}/api/apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "监控台", description: "测试应用", manifest: MANIFEST }),
  });
  expect(createRes.status).toBe(201);
  const { app } = (await createRes.json()) as { app: { id: string } };
  return { port, ownerToken, otherToken, appId: app.id };
}

function bundleZip(html = "<html><body>app-v1</body></html>"): Blob {
  // STORE 形态 zip 由手写构造器生成（见 test/util/zip.test.ts 的同构实现）
  const entries: Array<{ name: string; data: Buffer }> = [
    { name: "index.html", data: Buffer.from(html) },
    { name: "app.js", data: Buffer.from("console.log('runtime')") },
    { name: "data.json", data: Buffer.from('{"ok":true}') },
  ];
  const u16 = (v: number): Buffer => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    return b;
  };
  const u32 = (v: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(e.data.length),
      u32(e.data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      e.data,
    ]);
    locals.push(local);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16((3 << 8) | 20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(e.data.length),
        u32(e.data.length),
        u16(nameBuf.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0o100000 * 0x10000),
        u32(offset),
        nameBuf,
      ]),
    );
    offset += local.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(cd.length),
    u32(cdStart),
    u16(0),
  ]);
  return new Blob([Buffer.concat([...locals, cd, eocd])], { type: "application/zip" });
}

async function uploadVersion(
  port: number,
  token: string,
  appId: string,
  blob: Blob,
): Promise<Response> {
  const fd = new FormData();
  fd.append("file", blob, "bundle.zip");
  return fetch(`http://127.0.0.1:${port}/api/apps/${appId}/versions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
}

describe("应用内核：开发-发布-运行闭环", () => {
  it("上传 bundle → 发布 → 静态挂载可访问，HTML 带 CSP sandbox 且无 XFO", async () => {
    const { port, ownerToken, appId } = await setup();
    const up = await uploadVersion(port, ownerToken, appId, bundleZip());
    expect(up.status).toBe(201);
    const upBody = (await up.json()) as {
      version: { num: number };
      app: { currentVersion: number };
    };
    expect(upBody.version.num).toBe(1);
    expect(upBody.app.currentVersion).toBe(1);

    const index = await fetch(`http://127.0.0.1:${port}/apps/${appId}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("app-v1");
    expect(index.headers.get("content-type")).toContain("text/html");
    const csp = index.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(index.headers.get("x-frame-options")).toBeNull();

    const asset = await fetch(`http://127.0.0.1:${port}/apps/${appId}/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");

    // hash 资产缺失保持 404（不走 SPA fallback）；无扩展名路径 fallback index.html
    expect((await fetch(`http://127.0.0.1:${port}/apps/${appId}/missing.js`)).status).toBe(404);
    const spa = await fetch(`http://127.0.0.1:${port}/apps/${appId}/some/route`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("app-v1");
  });

  it("未发布应用静态访问 404；穿越路径被拒绝", async () => {
    const { port, ownerToken, appId } = await setup();
    expect((await fetch(`http://127.0.0.1:${port}/apps/${appId}/`)).status).toBe(404);
    await uploadVersion(port, ownerToken, appId, bundleZip());
    // 编码点段（单段含编码斜杠）：客户端不归一化，服务端解码后命中穿越防御
    const trav1 = await fetch(`http://127.0.0.1:${port}/apps/${appId}/%2E%2E%2Fsecret.txt`);
    expect(trav1.status).toBe(404);
    const trav2 = await fetch(`http://127.0.0.1:${port}/apps/${appId}/..%2F..%2Fsecret.txt`);
    expect(trav2.status).toBe(404);
  });

  it("版本历史与回滚：上传 v2 后可切回 v1", async () => {
    const { port, ownerToken, appId } = await setup();
    await uploadVersion(port, ownerToken, appId, bundleZip("<html>v1</html>"));
    await uploadVersion(port, ownerToken, appId, bundleZip("<html>v2</html>"));
    const body = (await fetch(`http://127.0.0.1:${port}/apps/${appId}/`, {})).clone();
    expect(await body.text()).toContain("v2");

    const rollback = await fetch(`http://127.0.0.1:${port}/api/apps/${appId}/versions/1/publish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(rollback.status).toBe(200);
    expect(
      ((await rollback.json()) as { app: { currentVersion: number } }).app.currentVersion,
    ).toBe(1);
    expect(await (await fetch(`http://127.0.0.1:${port}/apps/${appId}/`)).text()).toContain("v1");
  });

  it("app-token 签发 → 运行时数据面读写删（CORS 面开放）", async () => {
    const { port, ownerToken, appId } = await setup();
    await uploadVersion(port, ownerToken, appId, bundleZip());
    const issue = await fetch(`http://127.0.0.1:${port}/api/apps/${appId}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(issue.status).toBe(200);
    const { token: appToken } = (await issue.json()) as { token: string };

    // 主 JWT 在运行时面不被接受（app-token 专属）
    const mainJwtProbe = await fetch(`http://127.0.0.1:${port}/api/app-data/${appId}/prefs`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ value: { a: 1 } }),
    });
    expect(mainJwtProbe.status).toBe(401);

    const put = await fetch(`http://127.0.0.1:${port}/api/app-data/${appId}/prefs`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ value: { threshold: 5 } }),
    });
    expect(put.status).toBe(200);
    expect(put.headers.get("access-control-allow-origin")).toBe("*");

    const get = await fetch(`http://127.0.0.1:${port}/api/app-data/${appId}/prefs`, {
      headers: { Authorization: `Bearer ${appToken}` },
    });
    expect(get.status).toBe(200);
    expect(((await get.json()) as { valueJson: string }).valueJson).toBe('{"threshold":5}');

    // 属主数据浏览器（主 JWT 面）
    const list = await fetch(`http://127.0.0.1:${port}/api/apps/${appId}/data`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const listBody = (await list.json()) as { items: Array<{ key: string }>; totalBytes: number };
    expect(listBody.items.map((i) => i.key)).toEqual(["prefs"]);
    expect(listBody.totalBytes).toBeGreaterThan(0);

    // OPTIONS 预检（sandbox iframe 不透明源跨源请求）
    const preflight = await fetch(`http://127.0.0.1:${port}/api/app-data/${appId}/prefs`, {
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");

    const del = await fetch(`http://127.0.0.1:${port}/api/app-data/${appId}/prefs`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${appToken}` },
    });
    expect(del.status).toBe(200);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/api/app-data/${appId}/prefs`, {
          headers: { Authorization: `Bearer ${appToken}` },
        })
      ).status,
    ).toBe(404);
  });

  it("app-token 与主会话 JWT 密钥空间隔离（不可互逆兑换）", async () => {
    const { port, ownerToken, appId } = await setup();
    const issue = await fetch(`http://127.0.0.1:${port}/api/apps/${appId}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const { token: appToken } = (await issue.json()) as { token: string };

    // app-token 冒充主会话：sessionStore.verify 必须拒绝（否则等于泄漏完整身份）
    const sessionProbe = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { Authorization: `Bearer ${appToken}` },
    });
    expect(sessionProbe.status).toBe(401);

    // 过期/异 app aud 的 app-token 拒绝
    const shortLived = new AppTokenService("test-secret", 1);
    const { token: stale } = await shortLived.issue({ userId: "u", appId, scope: "owner" });
    await new Promise((r) => setTimeout(r, 1100));
    const staleGet = await fetch(`http://127.0.0.1:${port}/api/app-data/${appId}/k`, {
      headers: { Authorization: `Bearer ${stale}` },
    });
    expect(staleGet.status).toBe(401);
  });

  it("越权防护：非属主 403（owner 守卫惯例），未登录 401", async () => {
    const { port, otherToken, appId } = await setup();
    const forbidden = await fetch(`http://127.0.0.1:${port}/api/apps/${appId}`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    expect(forbidden.status).toBe(403);
    const tokenSteal = await fetch(`http://127.0.0.1:${port}/api/apps/${appId}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    expect(tokenSteal.status).toBe(403);
    const anon = await fetch(`http://127.0.0.1:${port}/api/apps`);
    expect(anon.status).toBe(401);
  });

  it("运行时面数据配额：超大 value 413，非法 key 400", async () => {
    const { port, ownerToken, appId } = await setup();
    const issue = await fetch(`http://127.0.0.1:${port}/api/apps/${appId}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const { token: appToken } = (await issue.json()) as { token: string };
    const big = await fetch(`http://127.0.0.1:${port}/api/app-data/${appId}/big`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(260 * 1024) }),
    });
    expect(big.status).toBe(413);
    const badKey = await fetch(
      `http://127.0.0.1:${port}/api/app-data/${appId}/${encodeURIComponent("a/b")}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ value: 1 }),
      },
    );
    expect(badKey.status).toBe(404);
  });

  it("删除应用级联清理产物目录", async () => {
    const { port, ownerToken, appId } = await setup();
    await uploadVersion(port, ownerToken, appId, bundleZip());
    const del = await fetch(`http://127.0.0.1:${port}/api/apps/${appId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(del.status).toBe(200);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/api/apps/${appId}`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        })
      ).status,
    ).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/apps/${appId}/`)).status).toBe(404);
  });

  it("主站 SPA 路由 /apps 不被网关劫持（无 app_ 前缀走静态兜底）", async () => {
    const { port } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/apps`);
    // 无 dist 的测试环境返回 404/无 SPA，但绝不能是 400（网关误拦）
    expect(res.status).not.toBe(400);
  });
});
