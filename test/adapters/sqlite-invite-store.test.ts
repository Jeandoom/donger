import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteInviteStore } from "../../src/adapters/sqlite-invite-store.js";
import { buildInvite } from "../../src/domain/invite.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
});
afterEach(() => {
  db.close();
});

function newStore(): SqliteInviteStore {
  const s = new SqliteInviteStore(db);
  s.migrate();
  return s;
}

describe("SqliteInviteStore", () => {
  it("create → getByToken → listByCreator", async () => {
    const s = newStore();
    const a = buildInvite({ createdBy: "u1", expiresInDays: 7, maxUses: 2 });
    const b = buildInvite({ createdBy: "u2", expiresInDays: 7, maxUses: 1 });
    await s.create(a);
    await s.create(b);
    expect((await s.getByToken(a.token))?.id).toBe(a.id);
    const mine = await s.listByCreator("u1");
    expect(mine.length).toBe(1);
    expect(mine[0]?.id).toBe(a.id);
  });

  it("consume 原子核销：未超限成功、超限拒绝", async () => {
    const s = newStore();
    const invite = buildInvite({ createdBy: "u1", expiresInDays: 7, maxUses: 2 });
    await s.create(invite);
    expect(await s.consume(invite.token, new Date())).toBe(true);
    expect(await s.consume(invite.token, new Date())).toBe(true);
    expect(await s.consume(invite.token, new Date())).toBe(false);
    const after = await s.getByToken(invite.token);
    expect(after?.usedCount).toBe(2);
  });

  it("过期后 consume 拒绝", async () => {
    const s = newStore();
    const invite = buildInvite({ createdBy: "u1", expiresInDays: 1, maxUses: 5 });
    await s.create(invite);
    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    expect(await s.consume(invite.token, future)).toBe(false);
  });

  it("disable 仅属主可禁用", async () => {
    const s = newStore();
    const invite = buildInvite({ createdBy: "u1", expiresInDays: 7, maxUses: 5 });
    await s.create(invite);
    expect(await s.disable(invite.id, "other")).toBe(false);
    expect(await s.disable(invite.id, "u1")).toBe(true);
    const after = await s.getByToken(invite.token);
    expect(after?.disabled).toBe(true);
    expect(await s.consume(invite.token, new Date())).toBe(false);
  });
});
