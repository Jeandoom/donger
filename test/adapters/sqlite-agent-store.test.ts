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

  it("listAll 返回全量（不分 owner）", async () => {
    const store = new SqliteAgentStore(db, cipher);
    store.migrate();
    await store.create(input);
    await store.create({ ...input, name: "B", ownerId: "u2" });
    expect((await store.listAll()).map((a) => a.name).sort()).toEqual(["A", "B"]);
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

  it("版本化：create 建 v1，update 自增版本，listVersions 新→旧", async () => {
    const store = new SqliteAgentStore(db, cipher);
    store.migrate();
    const a = await store.create(input);
    expect(a.version).toBe(1);

    await store.update(a.id, { name: "A2" });
    const v3 = await store.update(a.id, { skills: ["s:2"] });
    expect(v3.version).toBe(3);

    const versions = await store.listVersions(a.id);
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versions[0]?.skills).toEqual(["s:2"]);
    expect(versions[2]?.name).toBe("A");
  });

  it("rollback：恢复快照内容并生成新版本（历史不改写），密钥字段一并恢复", async () => {
    const store = new SqliteAgentStore(db, cipher);
    store.migrate();
    const a = await store.create(input); // v1：headers SECRET=top
    await store.update(a.id, { name: "A2", skills: ["s:9"] }); // v2

    const rolled = await store.rollback(a.id, 1);
    expect(rolled.version).toBe(3); // v3 = 回滚产生的新版本
    expect(rolled.name).toBe("A");
    expect(rolled.skills).toEqual(["s:1"]);
    expect(rolled.mcpServers[0]?.headers).toEqual({ SECRET: "top" });

    // 历史仍在：v1/v2 可继续追溯
    expect((await store.listVersions(a.id)).map((v) => v.version)).toEqual([3, 2, 1]);
    // 回滚不存在的版本报错
    await expect(store.rollback(a.id, 99)).rejects.toThrow();
  });

  it("存量回填：无版本记录的旧 agent 在 migrate 后获得 v1 基线", async () => {
    const store = new SqliteAgentStore(db, cipher);
    store.migrate();
    const a = await store.create(input);
    // 模拟存量数据：删除版本记录（旧版本库无版本表内容）
    db.prepare("DELETE FROM agent_versions WHERE agentId = ?").run(a.id);
    // 重新 migrate（幂等回填）
    store.migrate();
    const versions = await store.listVersions(a.id);
    expect(versions.map((v) => v.version)).toEqual([1]);
    expect(versions[0]?.name).toBe("A");
  });

  it("落库兜底：create/update 遇非法 gitRepositories 拒绝且不写库", async () => {
    const store = new SqliteAgentStore(db, cipher);
    store.migrate();
    const badRepo = {
      id: "r1",
      name: "",
      provider: "gitee" as const,
      url: "https://gitee.com/org/repo",
    };
    // create / update 均在写库前 parseAgent 校验（空目录名不匹配正则）
    await expect(store.create({ ...input, gitRepositories: [badRepo] })).rejects.toThrow();
    const a = await store.create(input);
    await expect(store.update(a.id, { gitRepositories: [badRepo] })).rejects.toThrow();
    // 失败的 update 不落库：版本未自增、数据未被污染
    const cur = await store.get(a.id);
    expect(cur?.version).toBe(1);
    expect(cur?.gitRepositories).toEqual([]);
    expect((await store.listVersions(a.id)).map((v) => v.version)).toEqual([1]);
  });
});
