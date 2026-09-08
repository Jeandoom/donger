import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import type { PackSkill, SkillPack } from "../../src/domain/skill-pack.js";

let db: Database.Database;
let store: SqliteSkillPackStore;
beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteSkillPackStore(db);
  store.migrate();
});
afterEach(() => db.close());

function pack(over: Partial<SkillPack> = {}): SkillPack {
  return {
    id: "p1",
    userId: "u1",
    slug: "demo",
    name: "demo",
    source: { kind: "paste" },
    installedPath: ".skills/demo",
    enabled: true,
    builtin: false,
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}
function skill(over: Partial<PackSkill> = {}): PackSkill {
  return {
    id: "s1",
    userId: "u1",
    packId: "p1",
    name: "alpha",
    description: "d",
    relativePath: "skills/alpha/SKILL.md",
    enabled: true,
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}

describe("SqliteSkillPackStore", () => {
  it("migrate 幂等", () => {
    expect(() => store.migrate()).not.toThrow();
  });

  it("upsertPack + listPacks + getPackBySlug 往返", async () => {
    await store.upsertPack(pack());
    const list = await store.listPacks("u1");
    expect(list).toHaveLength(1);
    expect(list[0]?.source.kind).toBe("paste");
    expect((await store.getPackBySlug("u1", "demo"))?.id).toBe("p1");
  });

  it("多用户隔离", async () => {
    await store.upsertPack(pack({ userId: "u1" }));
    await store.upsertPack(pack({ userId: "u2", id: "p2" }));
    expect(await store.listPacks("u1")).toHaveLength(1);
    expect(await store.listPacks("u2")).toHaveLength(1);
  });

  it("upsertSkills + listSkills", async () => {
    await store.upsertPack(pack());
    await store.upsertSkills("u1", "p1", [skill(), skill({ id: "s2", name: "beta" })]);
    expect((await store.listSkills("u1", "p1")).map((s) => s.name).sort()).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("setPackEnabled / setSkillEnabled", async () => {
    await store.upsertPack(pack());
    await store.upsertSkills("u1", "p1", [skill()]);
    await store.setPackEnabled("u1", "p1", false);
    await store.setSkillEnabled("u1", "s1", false);
    expect((await store.getPack("u1", "p1"))?.enabled).toBe(false);
    expect((await store.listSkills("u1", "p1"))[0]?.enabled).toBe(false);
  });

  it("listEnabledSkillsWithPack：仅启用 pack+skill", async () => {
    await store.upsertPack(pack());
    await store.upsertSkills("u1", "p1", [
      skill(),
      skill({ id: "s2", name: "beta", enabled: false }),
    ]);
    const active = await store.listEnabledSkillsWithPack("u1");
    expect(active.map((a) => a.skill.name)).toEqual(["alpha"]);
    expect(active[0]?.pack.name).toBe("demo");
  });

  it("deletePack 级联删 skills", async () => {
    await store.upsertPack(pack());
    await store.upsertSkills("u1", "p1", [skill()]);
    await store.deletePack("u1", "p1");
    expect(await store.listPacks("u1")).toHaveLength(0);
    expect(await store.listSkills("u1", "p1")).toHaveLength(0);
  });
});
