import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handleGetSkillRepo,
  handlePutSkillRepo,
  handleSyncSkillRepo,
  handleVerifySkillRepo,
  type SkillRepoApiDeps,
} from "../../src/adapters/skill-repo-api.js";
import { SqliteUserSkillRepoStore } from "../../src/adapters/sqlite-user-skill-repo-store.js";
import type { CredentialSetStore } from "../../src/ports/credential-set-store.js";

let store: SqliteUserSkillRepoStore;
let deps: SkillRepoApiDeps;
const calls: string[] = [];

function makeCredentialSets(
  templates: Array<{ code: string; kind: string } | undefined>,
): CredentialSetStore {
  return {
    getTemplate: async (code: string) => templates.find((t) => t?.code === code),
  } as unknown as CredentialSetStore;
}

beforeEach(() => {
  const db = new Database(":memory:");
  store = new SqliteUserSkillRepoStore(db);
  store.migrate();
  calls.length = 0;
  deps = {
    repoStore: store,
    credentialSets: makeCredentialSets([
      { code: "gitee-pat", kind: "git" },
      { code: "generic-1", kind: "generic" },
    ]),
    sync: {
      verify: async (_user, target) => {
        calls.push("verify");
        if (!target && !(await store.get("u1"))) return { ok: false, message: "未配置技能仓库" };
        return { ok: true, message: "连接成功" };
      },
      syncNow: async (userId: string) => {
        calls.push(`sync:${userId}`);
        return { ok: true, message: "已同步" };
      },
      forget: async (userId: string) => {
        calls.push(`forget:${userId}`);
        await store.remove(userId);
      },
    },
  };
});

describe("skill-repo-api", () => {
  it("GET 未配置返回 repo=null", async () => {
    const r = await handleGetSkillRepo("u1", {}, deps);
    expect(r.status).toBe(200);
    expect((r.json as { repo: unknown }).repo).toBeNull();
  });

  it("PUT 保存合法配置；非 git 凭证/不存在模板 400；非法 URL 400", async () => {
    const ok = await handlePutSkillRepo(
      "u1",
      { repoUrl: "https://gitee.com/me/skills.git", credentialCode: "gitee-pat", branch: "main" },
      deps,
    );
    expect(ok.status).toBe(200);
    expect((ok.json as { repo: { repoUrl: string } }).repo?.repoUrl).toBe(
      "https://gitee.com/me/skills.git",
    );

    const badCred = await handlePutSkillRepo(
      "u1",
      { repoUrl: "https://gitee.com/me/skills.git", credentialCode: "generic-1" },
      deps,
    );
    expect(badCred.status).toBe(400);

    const missingTpl = await handlePutSkillRepo(
      "u1",
      { repoUrl: "https://gitee.com/me/skills.git", credentialCode: "nope" },
      deps,
    );
    expect(missingTpl.status).toBe(400);

    const badUrl = await handlePutSkillRepo(
      "u1",
      { repoUrl: "https://u:p@gitee.com/me.git", credentialCode: "gitee-pat" },
      deps,
    );
    expect(badUrl.status).toBe(400);

    const notHttps = await handlePutSkillRepo(
      "u1",
      { repoUrl: "git@github.com:me/skills.git", credentialCode: "gitee-pat" },
      deps,
    );
    expect(notHttps.status).toBe(400);
  });

  it("PUT 空 repoUrl = 解绑（清配置）", async () => {
    await handlePutSkillRepo(
      "u1",
      { repoUrl: "https://gitee.com/me/skills.git", credentialCode: "gitee-pat" },
      deps,
    );
    const r = await handlePutSkillRepo("u1", { repoUrl: "" }, deps);
    expect(r.status).toBe(200);
    expect((r.json as { repo: unknown }).repo).toBeNull();
    expect(calls).toContain("forget:u1");
    expect(await store.get("u1")).toBeUndefined();
  });

  it("verify 支持 body 覆盖与已保存配置两条路径", async () => {
    const withBody = await handleVerifySkillRepo(
      "u1",
      { repoUrl: "https://gitee.com/x/y.git", credentialCode: "gitee-pat" },
      deps,
    );
    expect(withBody.status).toBe(200);
    expect(calls).toContain("verify");

    const noConfig = await handleVerifySkillRepo("u1", {}, deps);
    expect((noConfig.json as { ok: boolean }).ok).toBe(false);
  });

  it("sync 手动同步返回结果与最新状态", async () => {
    await handlePutSkillRepo(
      "u1",
      { repoUrl: "https://gitee.com/me/skills.git", credentialCode: "gitee-pat" },
      deps,
    );
    const r = await handleSyncSkillRepo("u1", {}, deps);
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
    expect(calls).toContain("sync:u1");
    expect((r.json as { repo: { repoUrl: string } }).repo?.repoUrl).toBe(
      "https://gitee.com/me/skills.git",
    );
  });
});
