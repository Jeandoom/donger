import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteHostStore } from "../../src/adapters/sqlite-host-store.js";
import { HostInputSchema } from "../../src/domain/host.js";

function makeStore() {
  const db = new Database(":memory:");
  const store = new SqliteHostStore(db);
  store.migrate();
  return { db, store };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    name: "homedb",
    host: "homedb.jeandom.com",
    port: 22,
    username: "ubuntu",
    credentialCode: "ssh-homedb",
    description: "stock-analysis 部署机",
    enabled: true,
    ...overrides,
  };
}

const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe("SqliteHostStore", () => {
  it("create 带默认值并可读回；属主隔离", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const h = await store.create(HostInputSchema.parse(input()), "u1");
    expect(h.id).toBeTruthy();
    expect(h.ownerId).toBe("u1");
    expect((await store.get(h.id))?.enabled).toBe(true);
    expect((await store.listHosts()).length).toBe(1);
  });

  it("字段安全 regex 拒绝（host 带 scheme / username 元字符 / 凭证 code 非法）", () => {
    expect(() => HostInputSchema.parse(input({ host: "https://h.example.com" }))).toThrow();
    expect(() => HostInputSchema.parse(input({ username: "a;b" }))).toThrow();
    expect(() => HostInputSchema.parse(input({ credentialCode: "Bad Code" }))).toThrow();
  });

  it("update 全量替换保留 id/owner/createdAt；delete 生效", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const h = await store.create(HostInputSchema.parse(input()), "u1");
    const updated = await store.update(
      h.id,
      HostInputSchema.parse(input({ name: "改名", enabled: false })),
    );
    expect(updated.name).toBe("改名");
    expect(updated.enabled).toBe(false);
    expect(updated.createdAt).toBe(h.createdAt);
    await store.delete(h.id);
    expect(await store.get(h.id)).toBeUndefined();
  });
});
