import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteUserSkillRepoStore } from "../../src/adapters/sqlite-user-skill-repo-store.js";
import type { UserSkillRepoInput } from "../../src/domain/user-skill-repo.js";

let store: SqliteUserSkillRepoStore;
const input: UserSkillRepoInput = {
  repoUrl: "https://gitee.com/me/skills.git",
  credentialCode: "gitee-pat",
  branch: "main",
  enabled: true,
};

beforeEach(() => {
  const db = new Database(":memory:");
  store = new SqliteUserSkillRepoStore(db);
  store.migrate();
});

describe("SqliteUserSkillRepoStore", () => {
  it("get 未配置返回 undefined；upsert 后可读回", async () => {
    expect(await store.get("u1")).toBeUndefined();
    await store.upsert("u1", input);
    const cfg = await store.get("u1");
    expect(cfg?.repoUrl).toBe(input.repoUrl);
    expect(cfg?.credentialCode).toBe("gitee-pat");
    expect(cfg?.branch).toBe("main");
    expect(cfg?.enabled).toBe(true);
  });

  it("重复 upsert 覆盖配置并清空同步状态", async () => {
    await store.upsert("u1", input);
    await store.setSyncStatus("u1", { at: "2026-09-20T00:00:00Z", status: "ok" });
    await store.upsert("u1", { ...input, branch: "master" });
    const cfg = await store.get("u1");
    expect(cfg?.branch).toBe("master");
    expect(cfg?.lastSyncAt).toBeUndefined();
    expect(cfg?.lastSyncStatus).toBeUndefined();
  });

  it("setSyncStatus 记录成败与错误摘要", async () => {
    await store.upsert("u1", input);
    await store.setSyncStatus("u1", {
      at: "2026-09-20T01:00:00Z",
      status: "failed",
      error: "推送失败",
    });
    let cfg = await store.get("u1");
    expect(cfg?.lastSyncStatus).toBe("failed");
    expect(cfg?.lastSyncError).toBe("推送失败");
    await store.setSyncStatus("u1", { at: "2026-09-20T02:00:00Z", status: "ok" });
    cfg = await store.get("u1");
    expect(cfg?.lastSyncStatus).toBe("ok");
    expect(cfg?.lastSyncError).toBeUndefined();
  });

  it("remove 解绑；各用户相互隔离", async () => {
    await store.upsert("u1", input);
    await store.upsert("u2", { ...input, repoUrl: "https://github.com/me/skills.git" });
    await store.remove("u1");
    expect(await store.get("u1")).toBeUndefined();
    expect((await store.get("u2"))?.repoUrl).toBe("https://github.com/me/skills.git");
  });
});
