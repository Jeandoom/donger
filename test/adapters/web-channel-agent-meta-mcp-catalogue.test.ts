import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteConnectorStore } from "../../src/adapters/sqlite-connector-store.js";
import { SqliteCredentialSetStore } from "../../src/adapters/sqlite-credential-set-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

const KEY_HEX = "0".repeat(64);

describe("WebChannel /api/agents/meta/options mcpTools 目录", () => {
  let web: WebChannel;
  let db: Database.Database;
  let csets: SqliteCredentialSetStore;
  let cstore: SqliteConnectorStore;
  let userToken: string;
  let adminToken: string;
  let staffId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    const sessionStore = new JwtSessionStore(db, "test-secret");
    sessionStore.migrate();
    const usersDir = mkdtempSync(join(tmpdir(), "mcp-cat-users-"));
    const userStore = new SqliteUserStore(db, { adminExternalIds: new Set(["boss"]), usersDir });
    userStore.migrate();
    const staff = await userStore.getOrCreateByIdentity("internal", "cat-staff", "目录测试员");
    const admin = await userStore.getOrCreateByIdentity("internal", "boss", "管理员");
    const other = await userStore.getOrCreateByIdentity("internal", "cat-other", "其他人");
    staffId = staff.id;
    userToken = (await sessionStore.create(staff.id)).token;
    adminToken = (await sessionStore.create(admin.id)).token;

    const cipher = createSecretCipher("test-seed");
    csets = SqliteCredentialSetStore.fromSeed(db, KEY_HEX);
    csets.migrate();
    cstore = new SqliteConnectorStore(db, cipher);
    cstore.migrate();

    // 连接器三态：staff 的 enabled global / staff 的 disabled / other 的 private（staff 不可见）
    await cstore.create(
      {
        name: "高德 MCP",
        url: "https://mcp.amap.com/mcp",
        headers: {},
        shareScope: "global",
      },
      staff.id,
    );
    await cstore.create(
      {
        name: "停用连接器",
        url: "https://mcp.example.com/mcp",
        headers: {},
        enabled: false,
        shareScope: "global",
      },
      staff.id,
    );
    await cstore.create(
      { name: "他人私有连接器", url: "https://mcp.private.com/mcp", headers: {} },
      other.id,
    );

    const tmp = mkdtempSync(join(tmpdir(), "mcp-cat-"));
    web = new WebChannel({
      port: 0,
      workspaceDir: tmp,
      sessionStore,
      userStore,
      credentialSets: csets,
      connectorStore: cstore,
    });
    web.onMessage(() => {});
    await web.ready();
  });

  afterEach(async () => {
    await web?.stop();
    db?.close();
  });

  const options = async (token: string) => {
    const res = await fetch(`http://127.0.0.1:${web.boundPort}/api/agents/meta/options`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      tools: string[];
      mcpTools: Array<{
        entry: string;
        server: string;
        label: string;
        hint: string;
        available: boolean;
      }>;
    };
  };

  it("内置四服务器恒在目录中；无主机凭证的普通用户 donger-host 置灰", async () => {
    const meta = await options(userToken);
    const byEntry = new Map(meta.mcpTools.map((m) => [m.entry, m]));
    expect(byEntry.get("mcp__donger-kb")).toMatchObject({ available: true, label: "知识库" });
    expect(byEntry.get("mcp__donger-git")).toMatchObject({ available: true });
    expect(byEntry.get("mcp__donger-platform")).toMatchObject({ available: true });
    expect(byEntry.get("mcp__donger-host")).toMatchObject({ available: false });
    // SDK 内置工具扁平候选不受影响
    expect(meta.tools).toContain("Bash");
  });

  it("名下有已填值主机凭证后 donger-host 变为可选；admin 无凭证也可选", async () => {
    await csets.createTemplate(
      "host-prod",
      {
        code: "host-prod",
        name: "生产主机",
        kind: "host",
        keySpecs: [{ key: "host" }, { key: "username" }, { key: "password" }],
      },
      "seed",
    );
    // admin 与 host 凭证无关：admin 即可用
    const adminMeta = await options(adminToken);
    expect(adminMeta.mcpTools.find((m) => m.entry === "mcp__donger-host")).toMatchObject({
      available: true,
    });

    // 普通用户填值前不可用 → 填值后同一请求内变为可用
    const before = await options(userToken);
    expect(before.mcpTools.find((m) => m.entry === "mcp__donger-host")).toMatchObject({
      available: false,
    });
    await csets.upsertValue(staffId, "host-prod", {
      host: "10.0.0.8",
      username: "root",
      password: "x",
    });
    const after = await options(userToken);
    expect(after.mcpTools.find((m) => m.entry === "mcp__donger-host")).toMatchObject({
      available: true,
    });
  });

  it("连接器目录：enabled 的 MCP 类型可选，disabled 置灰，他人 private 不可见，http 类型不进目录", async () => {
    await cstore.create(
      {
        name: "接口登记连接器",
        url: "https://api.example.com",
        headers: {},
        type: "http",
        shareScope: "global",
      },
      "seed-owner",
    );
    const meta = await options(userToken);
    const byEntry = new Map(meta.mcpTools.map((m) => [m.entry, m]));
    expect(byEntry.get("mcp__高德 MCP")).toMatchObject({ available: true, server: "高德 MCP" });
    expect(byEntry.get("mcp__停用连接器")).toMatchObject({ available: false });
    expect(byEntry.has("mcp__他人私有连接器")).toBe(false);
    expect(byEntry.has("mcp__接口登记连接器")).toBe(false);
  });
});
