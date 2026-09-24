import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteMcpTokenStore } from "../../src/adapters/sqlite-mcp-token-store.js";

describe("SqliteMcpTokenStore", () => {
  let store: SqliteMcpTokenStore;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new SqliteMcpTokenStore(db);
    store.migrate();
  });

  it("签发 → verify 命中属主；列表含记录但不含明文", async () => {
    const { token, record } = await store.issue("u1", "我的令牌", null);
    expect(token.startsWith("dgk_")).toBe(true);
    expect(record.userId).toBe("u1");
    expect(record.expiresAt).toBeNull();

    const authed = await store.verify(token);
    expect(authed).toEqual({ userId: "u1", tokenId: record.id });

    const list = await store.listByUser("u1");
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("我的令牌");
    expect(JSON.stringify(list)).not.toContain(token);
  });

  it("有效期令牌：未过期可验、过期即失效", async () => {
    const { token } = await store.issue("u1", "短期", 1);
    expect(await store.verify(token)).toBeDefined();

    // 直接把过期时间改到过去（免等待）
    db.prepare("UPDATE mcp_tokens SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    expect(await store.verify(token)).toBeUndefined();
  });

  it("吊销后失效；revoke 只作用于本人令牌", async () => {
    const { record, token } = await store.issue("u1", "to-revoke", null);
    expect(await store.revoke("other", record.id)).toBe(false);
    expect(await store.verify(token)).toBeDefined();
    expect(await store.revoke("u1", record.id)).toBe(true);
    expect(await store.verify(token)).toBeUndefined();
    // 重复吊销返回 false
    expect(await store.revoke("u1", record.id)).toBe(false);
  });

  it("非法令牌/前缀不符 → undefined；verify 节流回写 lastUsedAt", async () => {
    expect(await store.verify("")).toBeUndefined();
    expect(await store.verify("jwt-style-token")).toBeUndefined();
    const { token } = await store.issue("u1", "t", null);
    await store.verify(token);
    const first = (await store.listByUser("u1"))[0]?.lastUsedAt;
    expect(first).toBeTruthy();
    // 60s 节流窗口内不刷新
    await store.verify(token);
    const second = (await store.listByUser("u1"))[0]?.lastUsedAt;
    expect(second).toBe(first);
  });
});
