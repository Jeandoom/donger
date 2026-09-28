import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteConnectorStore } from "../../src/adapters/sqlite-connector-store.js";
import type { ConnectorInput } from "../../src/domain/connector.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

describe("SqliteConnectorStore", () => {
  let store: SqliteConnectorStore;
  const owner = randomUUID();
  const other = randomUUID();

  beforeEach(() => {
    store = new SqliteConnectorStore(new Database(":memory:"), createSecretCipher("test-seed"));
    store.migrate();
  });

  const input = (over: Partial<ConnectorInput> = {}): ConnectorInput => ({
    name: "高德地图 MCP",
    url: "https://mcp.amap.com/mcp",
    headers: { Authorization: "Bearer {{credential:amap-key}}" },
    ...over,
  });

  it("迁移幂等（重复 migrate 不炸）", () => {
    expect(() => store.migrate()).not.toThrow();
  });

  it("创建：默认值填充 + conn_ 前缀 id + owner 信息落库", async () => {
    const c = await store.create(input(), owner);
    expect(c.id.startsWith("conn_")).toBe(true);
    expect(c.transport).toBe("http");
    expect(c.type).toBe("mcp"); // 缺省类型 = mcp（存量行为）
    expect(c.enabled).toBe(true);
    expect(c.shareScope).toBe("private");
    expect(c.ownerId).toBe(owner);
    expect(c.headers.Authorization).toBe("Bearer {{credential:amap-key}}");
    expect((await store.getById(c.id))?.name).toBe("高德地图 MCP");
  });

  it("type：显式 http 落库；update 未带 type 沿用存量值（防 PATCH 误翻类型）", async () => {
    const c = await store.create(input({ name: "rest", type: "http" }), owner);
    expect((await store.getById(c.id))?.type).toBe("http");
    const updated = await store.update(c.id, input({ name: "rest-2" }));
    expect(updated.type).toBe("http");
    expect(updated.name).toBe("rest-2");
    const flipped = await store.update(c.id, input({ name: "rest-3", type: "mcp" }));
    expect(flipped.type).toBe("mcp");
  });

  it("owner 私有域内重名拒绝；跨 owner 同名互不干扰", async () => {
    const a = await store.create(input(), owner);
    await expect(store.create(input(), owner)).rejects.toThrow(); // 唯一索引 (ownerId, name)
    const b = await store.create(input(), other);
    expect(b.id).not.toBe(a.id);
    expect((await store.getByOwnerAndName(owner, "高德地图 MCP"))?.id).toBe(a.id);
    expect(await store.getByOwnerAndName(other, "不存在")).toBeUndefined();
  });

  it("URL 协议白名单：非 http/https 拒绝", async () => {
    await expect(store.create(input({ url: "ftp://x/mcp" }), owner)).rejects.toThrow(/http\/https/);
    await expect(store.create(input({ url: "not-a-url" }), owner)).rejects.toThrow();
  });

  it("listForUser：我的 private + 他人 global，不含他人 private", async () => {
    await store.create(input({ name: "mine" }), owner);
    await store.create(input({ name: "other-private" }), other);
    const global = await store.create(input({ name: "shared", shareScope: "global" }), other);

    const visible = await store.listForUser(owner);
    const names = visible.map((c) => c.name);
    expect(names).toContain("mine");
    expect(names).toContain("shared");
    expect(names).not.toContain("other-private");

    // global 创建者自己也可见（去重：仅一行）
    expect((await store.listForUser(other)).filter((c) => c.id === global.id)).toHaveLength(1);
  });

  it("listByIds：跨 owner 原样返回（可见性校验由调用方负责）", async () => {
    const a = await store.create(input({ name: "a" }), owner);
    const b = await store.create(input({ name: "b", shareScope: "global" }), other);
    const got = await store.listByIds([a.id, b.id, "conn_missing"]);
    expect(got.map((c) => c.name).sort()).toEqual(["a", "b"]);
    expect(await store.listByIds([])).toEqual([]);
  });

  it("headers 密文落库：data 中不含明文", async () => {
    const c = await store.create(
      input({ headers: { Authorization: "Bearer plain-secret-token" } }),
      owner,
    );
    const db = (store as unknown as { db: Database }).db;
    const row = db.prepare("SELECT data FROM connectors WHERE id = ?").get(c.id) as {
      data: string;
    };
    expect(row.data).not.toContain("plain-secret-token");
    // 读路径解密还原
    expect((await store.getById(c.id))?.headers.Authorization).toBe("Bearer plain-secret-token");
  });

  it("update：全量替换 + 重新加密 + 不存在抛 NotFoundError", async () => {
    const c = await store.create(input(), owner);
    const next = await store.update(c.id, input({ name: "改名", enabled: false }));
    expect(next.name).toBe("改名");
    expect(next.enabled).toBe(false);
    expect(next.updatedAt >= c.updatedAt).toBe(true);
    expect((await store.getById(c.id))?.enabled).toBe(false);
    await expect(store.update("conn_nope", input())).rejects.toThrow(/不存在/);
  });

  it("损坏密文行跳过，不放大为整列表失败", async () => {
    await store.create(input({ name: "good" }), owner);
    const db = (store as unknown as { db: Database }).db;
    db.prepare(
      "INSERT INTO connectors (id,ownerId,name,url,shareScope,enabled,data,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("conn_bad", owner, "bad", "https://x/mcp", "private", 1, "{not-json", "t", "t");
    const visible = await store.listForUser(owner);
    expect(visible.map((c) => c.name)).toEqual(["good"]);
    expect(await store.getById("conn_bad")).toBeUndefined();
  });

  it("删除后不可见", async () => {
    const c = await store.create(input(), owner);
    await store.delete(c.id);
    expect(await store.getById(c.id)).toBeUndefined();
  });
});
