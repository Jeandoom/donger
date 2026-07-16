import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteGitConnectionStore } from "../../src/adapters/sqlite-git-connection-store.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = join(tmpdir(), `git-connection-${crypto.randomUUID()}.db`);
  db = new Database(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(dbPath, { force: true });
});

describe("SqliteGitConnectionStore", () => {
  it("连接与密钥往返，数据库不出现明文 token", async () => {
    const store = new SqliteGitConnectionStore(db, createSecretCipher("test"));
    store.migrate();
    const saved = await store.save({
      userId: "u1",
      provider: "github",
      accountId: "42",
      accountName: "alice",
      authType: "pat",
      scopes: ["contents:read"],
      accessToken: "secret-token",
    });

    expect((await store.getDefault("u1", "github"))?.accountName).toBe("alice");
    expect(await store.getSecrets(saved.id)).toEqual({
      accessToken: "secret-token",
      refreshToken: undefined,
    });
    const raw = db.prepare("SELECT accessToken FROM git_connections").get() as {
      accessToken: string;
    };
    expect(raw.accessToken).not.toContain("secret-token");
  });

  it("仓库授权幂等更新，删除连接时级联删除", async () => {
    const store = new SqliteGitConnectionStore(db, createSecretCipher("test"));
    store.migrate();
    const connection = await store.save({
      userId: "u1",
      provider: "gitee",
      accountId: "7",
      accountName: "bob",
      authType: "pat",
      scopes: ["projects"],
      accessToken: "token",
    });
    await store.saveGrant({
      userId: "u1",
      agentId: "a1",
      repositoryId: "r1",
      repositoryFingerprint: "gitee:acme/repo",
      connectionId: connection.id,
      permission: "read",
      grantedAt: "t1",
    });

    expect((await store.getGrant("u1", "a1", "r1"))?.connectionId).toBe(connection.id);
    await store.delete(connection.id, "u1");
    expect(await store.getGrant("u1", "a1", "r1")).toBeUndefined();
  });
});
