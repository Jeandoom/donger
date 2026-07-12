import Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { SqliteAgentShareStore } from "../../src/adapters/sqlite-agent-share-store.js";
import { SqliteAgentStore } from "../../src/adapters/sqlite-agent-store.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

let dbPath: string;
let db: Database.Database;
beforeEach(() => {
  dbPath = join(tmpdir(), `share-${Math.random().toString(36).slice(2)}.db`);
  db = new Database(dbPath);
});
afterEach(() => {
  db.close();
  rmSync(dbPath, { force: true });
});

const input = {
  ownerId: "u1",
  name: "A",
  skills: [],
  tools: { mode: "all" as const, whitelist: [] },
  mcpServers: [],
  llm: {},
};

describe("SqliteAgentShareStore", () => {
  it("enableShare 生成 token；findByToken 可查；enabled=true", async () => {
    const s = new SqliteAgentShareStore(db);
    s.migrate();
    const share = await s.enableShare("a1");
    expect(share.agentId).toBe("a1");
    expect(share.token.length).toBeGreaterThan(10);
    expect(share.enabled).toBe(true);
    const ref = await s.findByToken(share.token);
    expect(ref).toEqual({ agentId: "a1", enabled: true });
  });

  it("disableShare 后 isGranted=false 且 getShare.enabled=false", async () => {
    const s = new SqliteAgentShareStore(db);
    s.migrate();
    await s.enableShare("a1");
    await s.addGrant("a1", "u2");
    expect(await s.isGranted("a1", "u2")).toBe(true);
    await s.disableShare("a1");
    expect(await s.isGranted("a1", "u2")).toBe(false);
    const share = await s.getShare("a1");
    expect(share?.enabled).toBe(false);
  });

  it("addGrant 幂等；listGrants 去重", async () => {
    const s = new SqliteAgentShareStore(db);
    s.migrate();
    await s.enableShare("a1");
    await s.addGrant("a1", "u2");
    await s.addGrant("a1", "u2");
    expect((await s.listGrants("a1")).length).toBe(1);
  });

  it("removeGrant 后 isGranted=false", async () => {
    const s = new SqliteAgentShareStore(db);
    s.migrate();
    await s.enableShare("a1");
    await s.addGrant("a1", "u2");
    await s.removeGrant("a1", "u2");
    expect(await s.isGranted("a1", "u2")).toBe(false);
  });

  it("跨 store：listSharedWith 命中已授权 agent（联表）", async () => {
    const cipher = createSecretCipher("pw");
    const agents = new SqliteAgentStore(db, cipher);
    const shares = new SqliteAgentShareStore(db);
    agents.migrate();
    shares.migrate();
    const a = await agents.create(input);
    await shares.enableShare(a.id);
    await shares.addGrant(a.id, "u2");
    expect((await agents.listSharedWith("u2")).map((x) => x.id)).toEqual([a.id]);
  });
});
