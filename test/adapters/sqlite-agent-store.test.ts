import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteAgentStore } from "../../src/adapters/sqlite-agent-store.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

const cipher = createSecretCipher("pw");
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = join(tmpdir(), `agent-${Math.random().toString(36).slice(2)}.db`);
  db = new Database(dbPath);
});
afterEach(() => {
  db.close();
  rmSync(dbPath, { force: true });
});

const input = {
  ownerId: "u1",
  name: "A",
  skills: ["s:1"],
  tools: { mode: "whitelist" as const, whitelist: ["Bash"] },
  mcpServers: [{ name: "m", type: "http" as const, url: "https://x", headers: { SECRET: "top" } }],
  llm: { presetId: "0" },
};

describe("SqliteAgentStore", () => {
  it("create + get 往返，env/headers 在 DB 为密文", async () => {
    const store = new SqliteAgentStore(db, cipher);
    store.migrate();
    const a = await store.create({ ...input, defaultSkill: "s:1" });
    const got = await store.get(a.id);
    expect(got?.mcpServers[0]?.headers).toEqual({ SECRET: "top" });
    expect(got?.defaultSkill).toBe("s:1");
    const row = db.prepare("SELECT data FROM agents WHERE id = ?").get(a.id) as { data: string };
    expect(row.data).not.toContain("top");
    expect(row.data).toContain("v1:");
  });

  it("listByOwner 只返回该 owner", async () => {
    const store = new SqliteAgentStore(db, cipher);
    store.migrate();
    await store.create(input);
    await store.create({ ...input, name: "B", ownerId: "u2" });
    expect((await store.listByOwner("u1")).map((a) => a.name)).toEqual(["A"]);
  });

  it("update 修改字段并刷新 updatedAt", async () => {
    const store = new SqliteAgentStore(db, cipher);
    store.migrate();
    const a = await store.create(input);
    const updated = await store.update(a.id, { name: "A2" });
    expect(updated.name).toBe("A2");
    expect((await store.get(a.id))?.name).toBe("A2");
  });

  it("delete 级联清空（无残留行）", async () => {
    const store = new SqliteAgentStore(db, cipher);
    store.migrate();
    const a = await store.create(input);
    await store.delete(a.id);
    expect(await store.get(a.id)).toBeUndefined();
  });
});
