import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteAgentStore } from "../../src/adapters/sqlite-agent-store.js";
import { SqliteConnectorStore } from "../../src/adapters/sqlite-connector-store.js";
import { SqliteCredentialSetStore } from "../../src/adapters/sqlite-credential-set-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

const KEY_HEX = "0".repeat(64);

describe("WebChannel /api/connectors", () => {
  let web: WebChannel;
  let db: Database.Database;
  let token: string;
  let uid: string;
  let cstore: SqliteConnectorStore;

  /** 桩 MCP server：initialize/tools/list 正常应答并下发 session id */
  let mcp: Server;
  let mcpUrl: string;
  let mcpCalls: string[];

  beforeEach(async () => {
    db = new Database(":memory:");
    const sessionStore = new JwtSessionStore(db, "test-secret");
    sessionStore.migrate();
    const usersDir = mkdtempSync(join(tmpdir(), "web-conn-users-"));
    const userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
    userStore.migrate();
    const user = await userStore.getOrCreateByIdentity("internal", "conn-staff", "连接器测试");
    uid = user.id;
    token = (await sessionStore.create(user.id)).token;

    const cipher = createSecretCipher("test-seed");
    cstore = new SqliteConnectorStore(db, cipher);
    cstore.migrate();
    const csets = new SqliteCredentialSetStore(db, KEY_HEX);
    csets.migrate();
    const agentStore = new SqliteAgentStore(db, cipher);
    agentStore.migrate();

    mcpCalls = [];
    mcp = createServer((req, res) => {
      let body = "";
      req.on("data", (d: Buffer) => (body += d.toString()));
      req.on("end", () => {
        const rpc = JSON.parse(body) as { id?: number; method?: string };
        mcpCalls.push(rpc.method ?? "");
        if (rpc.method === "initialize") {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Mcp-Session-Id": "sess-123",
          });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: { protocolVersion: "2025-06-18", capabilities: {} },
            }),
          );
          return;
        }
        if (rpc.method === "tools/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: { tools: [{ name: "geocode" }, { name: "poi_search" }] },
            }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result: {} }));
      });
    });
    await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
    const addr = mcp.address();
    if (!addr || typeof addr === "string") throw new Error("no mcp port");
    mcpUrl = `http://127.0.0.1:${addr.port}/mcp`;

    const tmp = mkdtempSync(join(tmpdir(), "web-conn-"));
    web = new WebChannel({
      port: 0,
      workspaceDir: tmp,
      sessionStore,
      credentialSets: csets,
      connectorStore: cstore,
      agentStore,
    });
    web.onMessage(() => {});
    await web.ready();
  });

  afterEach(async () => {
    await web?.stop();
    mcp?.close();
    db?.close();
  });

  const auth = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

  it("CRUD：创建/列表双区/掩码/更新掩码回填/删除", async () => {
    // 创建（带字面量 + 凭证引用两种 header）
    const res = await fetch(`http://127.0.0.1:${web.boundPort}/api/connectors`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        name: "高德 MCP",
        url: "https://mcp.amap.com/mcp",
        headers: { Authorization: "Bearer literal-secret", "X-Ref": "{{credential:amap}}" },
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; headers: Record<string, string> };
    // 字面量掩码，引用保持可读
    expect(created.headers.Authorization).toBe("••••");
    expect(created.headers["X-Ref"]).toBe("{{credential:amap}}");

    // 列表：mine 分区 + usedBy
    const listRes = await fetch(`http://127.0.0.1:${web.boundPort}/api/connectors`, {
      headers: auth(),
    });
    const list = (await listRes.json()) as {
      connectors: Array<{ name: string; shareScope: string; createdByMe: boolean; usedBy: number }>;
    };
    expect(list.connectors).toHaveLength(1);
    expect(list.connectors[0]).toMatchObject({
      name: "高德 MCP",
      shareScope: "private",
      createdByMe: true,
      usedBy: 0,
    });

    // 重名 → 409
    const dup = await fetch(`http://127.0.0.1:${web.boundPort}/api/connectors`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "高德 MCP", url: "https://x/mcp" }),
    });
    expect(dup.status).toBe(409);

    // 更新：掩码占位回填原值（不改字面量），引用可改
    const patch = await fetch(`http://127.0.0.1:${web.boundPort}/api/connectors/${created.id}`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({
        name: "高德 MCP",
        url: "https://mcp.amap.com/v2",
        headers: { Authorization: "••••", "X-Ref": "{{credential:amap2}}" },
      }),
    });
    expect(patch.status).toBe(200);
    const raw = db.prepare("SELECT data FROM connectors WHERE id = ?").get(created.id) as {
      data: string;
    };
    // 密文落库：明文 token 与新引用值均不出现在 data（引用语法在 headers 密文内）
    expect(raw.data).not.toContain("literal-secret");
    const detail = (await patch.json()) as { headers: Record<string, string>; url: string };
    expect(detail.url).toBe("https://mcp.amap.com/v2");
    expect(detail.headers.Authorization).toBe("••••");
    expect(detail.headers["X-Ref"]).toBe("{{credential:amap2}}");

    // 删除
    const del = await fetch(`http://127.0.0.1:${web.boundPort}/api/connectors/${created.id}`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(del.status).toBe(200);
  });

  it("可见性与权限：他人 private 不可见不可改；global 人人可见、仅创建人可改", async () => {
    const mine = await cstore.create({ name: "mine", url: "https://a/mcp" }, uid);
    const othersPrivate = await cstore.create(
      { name: "hidden", url: "https://b/mcp" },
      "other-user",
    );
    const othersGlobal = await cstore.create(
      { name: "shared", url: "https://c/mcp", shareScope: "global" },
      "other-user",
    );

    const base = `http://127.0.0.1:${web.boundPort}`;
    // 他人 private：详情 403；global：详情可见但改 403
    expect(
      (await fetch(`${base}/api/connectors/${othersPrivate.id}`, { headers: auth() })).status,
    ).toBe(403);
    const g = await fetch(`${base}/api/connectors/${othersGlobal.id}`, { headers: auth() });
    expect(g.status).toBe(200);
    const patch = await fetch(`${base}/api/connectors/${othersGlobal.id}`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ name: "hack", url: "https://c/mcp" }),
    });
    expect(patch.status).toBe(403);
    expect(mine.id).toBeTruthy();
  });

  it("test 端点：凭证引用按发起者解析，探活返回工具清单", async () => {
    const csets = new SqliteCredentialSetStore(db, KEY_HEX);
    await csets.upsertValue(uid, "amap", { token: "live-key" });

    const res = await fetch(`http://127.0.0.1:${web.boundPort}/api/connectors/test`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        url: mcpUrl,
        headers: { Authorization: "Bearer {{credential:amap}}" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      toolCount: number;
      tools: string[];
      latencyMs: number;
    };
    expect(body.ok).toBe(true);
    expect(body.toolCount).toBe(2);
    expect(body.tools).toEqual(["geocode", "poi_search"]);
    expect(mcpCalls).toContain("initialize");
    expect(mcpCalls).toContain("tools/list");
  });

  it("test 端点：凭证未配置 → ok:false 带缺失提示；不可达地址 → ok:false 带错误", async () => {
    const base = `http://127.0.0.1:${web.boundPort}`;
    const miss = await fetch(`${base}/api/connectors/test`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ url: mcpUrl, headers: { Authorization: "{{credential:nope}}" } }),
    });
    const missBody = (await miss.json()) as { ok: boolean; error: string };
    expect(missBody.ok).toBe(false);
    expect(missBody.error).toContain("nope");

    const bad = await fetch(`${base}/api/connectors/test`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ url: "http://127.0.0.1:1/nope", headers: {} }),
    });
    const badBody = (await bad.json()) as { ok: boolean; error?: string };
    expect(badBody.ok).toBe(false);
    expect(badBody.error).toBeTruthy();
  });
});
