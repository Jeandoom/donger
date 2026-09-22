import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SqliteKbLibraryStore,
  SqliteKbRevisionStore,
  SqliteKbShareStore,
} from "../../src/adapters/sqlite-kb-store.js";

/**
 * 知识库三表 store（spec 2026-09-22-knowledge-base-design §6）：
 * CRUD / 个人库懒 ensure 幂等 / 分享 enabled 联结 / 修订保留策略（同 path 最近 50 条留 diff）。
 */

let db: Database.Database;
let libraries: SqliteKbLibraryStore;
let shares: SqliteKbShareStore;
let revisions: SqliteKbRevisionStore;

beforeEach(() => {
  db = new Database(":memory:");
  libraries = new SqliteKbLibraryStore(db);
  libraries.migrate();
  shares = new SqliteKbShareStore(db);
  shares.migrate();
  revisions = new SqliteKbRevisionStore(db);
  revisions.migrate();
});

describe("SqliteKbLibraryStore", () => {
  it("create/get/listByOwner 往返（builtin/personal 标志）", async () => {
    const lib = await libraries.create({
      ownerId: "u1",
      name: "产品知识",
      description: "d",
      systemPrompt: "sp",
      builtin: false,
      personal: false,
    });
    const got = await libraries.get(lib.id);
    expect(got?.name).toBe("产品知识");
    expect(got?.personal).toBe(false);

    const builtin = await libraries.create({
      ownerId: "__builtin__",
      name: "平台手册",
      description: "",
      systemPrompt: "",
      builtin: true,
      personal: false,
    });
    expect((await libraries.get(builtin.id))?.builtin).toBe(true);
    expect((await libraries.listByOwner("u1")).map((l) => l.name)).toEqual(["产品知识"]);
  });

  it("ensurePersonalLibrary 幂等：多次调用返回同一个库", async () => {
    const a = await libraries.ensurePersonalLibrary("u1");
    const b = await libraries.ensurePersonalLibrary("u1");
    expect(a.id).toBe(b.id);
    expect(a.personal).toBe(true);
    expect(a.name).toBe("个人知识库");
    // 不同用户各自一个
    const c = await libraries.ensurePersonalLibrary("u2");
    expect(c.id).not.toBe(a.id);
  });

  it("update 记录变更且 update 不改 ownerId/createdAt", async () => {
    const lib = await libraries.create({
      ownerId: "u1",
      name: "n1",
      description: "",
      systemPrompt: "",
      builtin: false,
      personal: false,
    });
    const updated = await libraries.update(lib.id, { name: "n2", systemPrompt: "sp2" });
    expect(updated.name).toBe("n2");
    expect(updated.systemPrompt).toBe("sp2");
    expect(updated.ownerId).toBe("u1");
    expect(updated.createdAt).toBe(lib.createdAt);
  });

  it("delete 级联清分享，账本独立保留", async () => {
    const lib = await libraries.create({
      ownerId: "u1",
      name: "del-me",
      description: "",
      systemPrompt: "",
      builtin: false,
      personal: false,
    });
    await shares.enableShare(lib.id);
    await shares.addGrant(lib.id, "u2");
    await revisions.record({
      kbId: lib.id,
      path: "a.md",
      action: "create",
      actorUserId: "u1",
      actorKind: "chat",
    });
    await libraries.delete(lib.id);
    expect(await libraries.get(lib.id)).toBeUndefined();
    expect(await shares.getShare(lib.id)).toBeUndefined();
    expect(await shares.isGranted(lib.id, "u2")).toBe(false);
    // 账本仍在（spec §6.1 删库不清账本）
    expect(await revisions.countByKb(lib.id)).toBe(1);
  });

  it("同属主同名撞 UNIQUE；不同属主同名允许", async () => {
    await libraries.create({
      ownerId: "u1",
      name: "dup",
      description: "",
      systemPrompt: "",
      builtin: false,
      personal: false,
    });
    await expect(
      libraries.create({
        ownerId: "u1",
        name: "dup",
        description: "",
        systemPrompt: "",
        builtin: false,
        personal: false,
      }),
    ).rejects.toThrow();
    const other = await libraries.create({
      ownerId: "u2",
      name: "dup",
      description: "",
      systemPrompt: "",
      builtin: false,
      personal: false,
    });
    expect(other.ownerId).toBe("u2");
  });
});

describe("SqliteKbShareStore", () => {
  it("enable/disable/find token；grants 只在 enabled=1 时生效", async () => {
    const share = await shares.enableShare("kb1");
    expect(share.enabled).toBe(true);
    await shares.addGrant("kb1", "u9");
    expect(await shares.isGranted("kb1", "u9")).toBe(true);

    await shares.disableShare("kb1");
    // grants 保留但全部失效（对齐 agent 分享语义）
    expect(await shares.isGranted("kb1", "u9")).toBe(false);
    expect((await shares.listGrants("kb1")).length).toBe(1);

    const ref = await shares.findByToken(share.token);
    expect(ref?.enabled).toBe(false);
  });
});

describe("SqliteKbRevisionStore 保留策略", () => {
  it("同 kbId+path 最近 50 条留 diff/summary，更早行保留但置空", async () => {
    for (let i = 1; i <= 52; i++) {
      await revisions.record({
        kbId: "kb1",
        path: "a.md",
        action: "update",
        actorUserId: "u1",
        actorKind: "chat",
        summary: `v${i}`,
        diffText: `diff-${i}`,
      });
    }
    const all = await revisions.listByKb("kb1", { path: "a.md", limit: 100 });
    expect(all.length).toBe(52);
    // 最新 50 条留全文
    const kept = all.filter((r) => r.diffText !== undefined);
    expect(kept.length).toBe(50);
    expect(kept[0]?.summary).toBe("v52");
    // 最旧 2 条置空但行还在（时间线不断）
    const pruned = all.filter((r) => r.diffText === undefined);
    expect(pruned.length).toBe(2);
    expect(pruned[0]?.createdAt).toBeTruthy();
    // 其它 path 不受影响
    await revisions.record({
      kbId: "kb1",
      path: "b.md",
      action: "create",
      actorUserId: "u1",
      actorKind: "chat",
      summary: "b1",
      diffText: "diff-b",
    });
    const b = await revisions.listByKb("kb1", { path: "b.md" });
    expect(b[0]?.diffText).toBe("diff-b");
  });

  it("listAll 全量时间线降序（审计页口径）", async () => {
    await revisions.record({
      kbId: "kbA",
      path: "",
      action: "config",
      actorUserId: "u1",
      actorKind: "manual",
    });
    await revisions.record({
      kbId: "kbB",
      path: "",
      action: "library-deleted",
      actorUserId: "u1",
      actorKind: "system",
    });
    const all = await revisions.listAll({ limit: 10, offset: 0 });
    expect(all.map((r) => r.kbId)).toEqual(["kbB", "kbA"]);
  });
});
