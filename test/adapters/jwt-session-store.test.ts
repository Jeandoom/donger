import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";

describe("JwtSessionStore", () => {
  let db: Database.Database;
  let store: JwtSessionStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new JwtSessionStore(db, "test-secret");
    store.migrate();
  });

  afterEach(() => {
    db.close();
  });

  it("create → verify 返回正确 userId", async () => {
    const { token } = await store.create("user-1");
    const userId = await store.verify(token);
    expect(userId).toBe("user-1");
  });

  it("无效 token → null", async () => {
    const result = await store.verify("invalid.token.here");
    expect(result).toBeNull();
  });

  it("签名篡改 → null", async () => {
    const { token } = await store.create("user-1");
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.tampered`;
    const result = await store.verify(tampered);
    expect(result).toBeNull();
  });

  it("revoke 后 verify → null", async () => {
    const { token, jti } = await store.create("user-1");
    await store.revoke(jti);
    const result = await store.verify(token);
    expect(result).toBeNull();
  });

  it("isRevoked 正确返回", async () => {
    const { jti } = await store.create("user-1");
    expect(await store.isRevoked(jti)).toBe(false);
    await store.revoke(jti);
    expect(await store.isRevoked(jti)).toBe(true);
  });
});