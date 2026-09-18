import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteAgentCallbackStore } from "../../src/adapters/sqlite-agent-callback-store.js";

let dbPath: string;
let db: Database.Database;
beforeEach(() => {
  dbPath = join(tmpdir(), `callback-${Math.random().toString(36).slice(2)}.db`);
  db = new Database(dbPath);
});
afterEach(() => {
  db.close();
  rmSync(dbPath, { force: true });
});

describe("SqliteAgentCallbackStore", () => {
  it("upsert 缺省 validityDays → 不过期（expiresAt=null）；token 为 32 位高熵串", async () => {
    const s = new SqliteAgentCallbackStore(db);
    s.migrate();
    const cb = await s.upsert("a1", "u1");
    expect(cb.agentId).toBe("a1");
    expect(cb.ownerId).toBe("u1");
    expect(cb.expiresAt).toBeNull();
    expect(cb.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const ref = await s.findByToken(cb.token);
    expect(ref?.agentId).toBe("a1");
  });

  it("upsert 带 validityDays → expiresAt 按天推算", async () => {
    const s = new SqliteAgentCallbackStore(db);
    s.migrate();
    const before = Date.now();
    const cb = await s.upsert("a1", "u1", 30);
    const exp = new Date(cb.expiresAt ?? "").getTime();
    const days = (exp - before) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("重新生成：旧 token 失效，新 token 生效（即吊销）", async () => {
    const s = new SqliteAgentCallbackStore(db);
    s.migrate();
    const first = await s.upsert("a1", "u1", 360);
    const second = await s.upsert("a1", "u1", 30);
    expect(second.token).not.toBe(first.token);
    expect(await s.findByToken(first.token)).toBeUndefined();
    expect((await s.findByToken(second.token))?.agentId).toBe("a1");
    expect((await s.get("a1"))?.token).toBe(second.token);
  });

  it("revoke 后 get/findByToken 均查不到", async () => {
    const s = new SqliteAgentCallbackStore(db);
    s.migrate();
    const cb = await s.upsert("a1", "u1");
    await s.revoke("a1");
    expect(await s.get("a1")).toBeUndefined();
    expect(await s.findByToken(cb.token)).toBeUndefined();
  });
});
