import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteCredentialStore } from "../../src/adapters/sqlite-credential-store.js";
import { loadOrGenerateAppSecret } from "../../src/util/app-secret.js";

let db: Database.Database;
let store: SqliteCredentialStore;
beforeEach(() => {
  db = new Database(":memory:");
  const key = loadOrGenerateAppSecret(db, "skill_secret_key");
  store = new SqliteCredentialStore(db, key);
  store.migrate();
});
afterEach(() => db.close());

describe("SqliteCredentialStore", () => {
  it("set/getMany 往返解密", async () => {
    await store.setValue("u1", "GITHUB_TOKEN", "ghp_xxx", "GitHub");
    const v = await store.getMany("u1", ["GITHUB_TOKEN", "MISSING"]);
    expect(v.GITHUB_TOKEN).toBe("ghp_xxx");
    expect(v.MISSING).toBeUndefined();
  });

  it("多用户隔离", async () => {
    await store.setValue("u1", "K", "a");
    await store.setValue("u2", "K", "b");
    expect((await store.getMany("u1", ["K"])).K).toBe("a");
    expect((await store.getMany("u2", ["K"])).K).toBe("b");
  });

  it("list + delete", async () => {
    await store.setValue("u1", "K", "v", "L");
    expect((await store.list("u1"))[0]?.key).toBe("K");
    await store.deleteValue("u1", "K");
    expect(await store.list("u1")).toHaveLength(0);
  });

  it("覆盖更新同 key", async () => {
    await store.setValue("u1", "K", "v1");
    await store.setValue("u1", "K", "v2");
    expect((await store.getMany("u1", ["K"])).K).toBe("v2");
    expect(await store.list("u1")).toHaveLength(1);
  });
});
