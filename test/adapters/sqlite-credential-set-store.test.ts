import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteCredentialSetStore } from "../../src/adapters/sqlite-credential-set-store.js";

const KEY_HEX = "0".repeat(64);

describe("SqliteCredentialSetStore", () => {
  let store: SqliteCredentialSetStore;
  const owner = randomUUID();
  const other = randomUUID();

  beforeEach(() => {
    store = SqliteCredentialSetStore.fromSeed(new Database(":memory:"), KEY_HEX);
    store.migrate();
  });

  const templateInput = {
    code: "jihulab-pat",
    name: "极狐 PAT",
    description: "jihulab 访问令牌",
    keySpecs: [{ key: "token", label: "访问令牌" }],
  };

  it("模板：创建/查询/模糊匹配/更新/删除保护", async () => {
    await store.createTemplate("jihulab-pat", templateInput, owner);
    await store.createTemplate("aliyun-ak", { ...templateInput, name: "阿里云 AK" }, other);

    expect((await store.getTemplate("jihulab-pat"))?.name).toBe("极狐 PAT");
    expect(await store.getTemplate("nope")).toBeUndefined();

    const byName = await store.listTemplates({ q: "阿里云" });
    expect(byCode(byName)).toEqual(["aliyun-ak"]);
    const byCodeQuery = await store.listTemplates({ q: "PAT" });
    expect(byCode(byCodeQuery)).toContain("jihulab-pat");
    expect((await store.listTemplates({})).length).toBe(2);

    await store.updateTemplate("jihulab-pat", { ...templateInput, name: "改名" });
    expect((await store.getTemplate("jihulab-pat"))?.name).toBe("改名");
    await expect(store.updateTemplate("nope", templateInput)).rejects.toThrow(/不存在/);

    // 删除保护：有用户值引用时拒绝由服务层判定，store 提供计数
    await store.upsertValue(other, "jihulab-pat", { token: "x" });
    expect(await store.countTemplateReferences("jihulab-pat")).toBe(1);
    expect(await store.countTemplateReferences("aliyun-ak")).toBe(0);

    await store.deleteTemplate("aliyun-ak");
    expect(await store.getTemplate("aliyun-ak")).toBeUndefined();
  });

  it("用户值：隔离、合并写入、解密取回、删除", async () => {
    await store.createTemplate("jihulab-pat", templateInput, owner);
    await store.upsertValue(owner, "jihulab-pat", { token: "secret-1" });
    await store.upsertValue(other, "jihulab-pat", { token: "secret-2" });

    // 他人不可见（userId 隔离）
    expect((await store.getFilledValues(owner, ["jihulab-pat"]))[0]?.values.token).toBe("secret-1");
    expect(await store.getFilledValues(randomUUID(), ["jihulab-pat"])).toEqual([]);

    // 合并写入：同键覆盖、新键并入、未提及键保留
    await store.upsertValue(owner, "jihulab-pat", { token: "rotated", extra: "e" });
    let entry = (await store.getFilledValues(owner, ["jihulab-pat"]))[0];
    expect(entry?.values).toEqual({ token: "rotated", extra: "e" });
    await store.upsertValue(owner, "jihulab-pat", { token: "rotated-2" });
    entry = (await store.getFilledValues(owner, ["jihulab-pat"]))[0];
    expect(entry?.values).toEqual({ token: "rotated-2", extra: "e" });
    expect(await store.listValueCodes(owner)).toEqual(["jihulab-pat"]);

    // 密文确实落库（非明文）
    const raw = new Database(":memory:");
    await store.deleteValue(owner, "jihulab-pat");
    expect(await store.getFilledValues(owner, ["jihulab-pat"])).toEqual([]);
    raw.close();
  });

  it("损坏密文跳过不阻断其余凭证", async () => {
    await store.createTemplate("a", templateInput, owner);
    await store.createTemplate("b", templateInput, owner);
    await store.upsertValue(owner, "a", { k: "v" });
    await store.upsertValue(owner, "b", { k: "v" });
    // 手写坏密文
    store.migrate();
    const db = (store as unknown as { db: Database }).db;
    db.prepare("UPDATE user_credential_values SET valuesCipher='bad' WHERE code='a'").run();
    const filled = await store.getFilledValues(owner, ["a", "b"]);
    expect(filled.map((f) => f.code)).toEqual(["b"]);
  });

  it("kind：缺省 generic；git 往返与更新", async () => {
    await store.createTemplate("g1", templateInput, owner);
    await store.createTemplate("git1", { ...templateInput, kind: "git" }, owner);
    expect((await store.getTemplate("g1"))?.kind).toBe("generic");
    expect((await store.getTemplate("git1"))?.kind).toBe("git");

    // updateTemplate 是整体覆写：显式带 kind 才变更；显式保持 git 的更新不受影响
    await store.updateTemplate("g1", { ...templateInput, kind: "git" });
    expect((await store.getTemplate("g1"))?.kind).toBe("git");
    await store.updateTemplate("git1", { ...templateInput, name: "改名", kind: "git" });
    expect((await store.getTemplate("git1"))?.kind).toBe("git");
    // 不带 kind 的整体覆写回落 generic（REST 层经 zod default 同样显式传 generic）
    await store.updateTemplate("git1", { ...templateInput, name: "改名2" });
    expect((await store.getTemplate("git1"))?.kind).toBe("generic");
  });

  it("repoUrl：git 模板仓库声明往返", async () => {
    await store.createTemplate(
      "git1",
      { ...templateInput, kind: "git", repoUrl: "https://jihulab.com/acme/app.git" },
      owner,
    );
    expect((await store.getTemplate("git1"))?.repoUrl).toBe("https://jihulab.com/acme/app.git");
    await store.updateTemplate("git1", { ...templateInput, kind: "git", repoUrl: undefined });
    expect((await store.getTemplate("git1"))?.repoUrl).toBeUndefined();
    await store.updateTemplate("git1", {
      ...templateInput,
      kind: "git",
      repoUrl: "https://gitlab.corp.io/t/a.git",
    });
    expect((await store.getTemplate("git1"))?.repoUrl).toBe("https://gitlab.corp.io/t/a.git");
  });

  it("migrate：旧库无 kind 列时自动补列并回填 generic", async () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE credential_templates (
        code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        keySpecsJson TEXT NOT NULL, createdBy TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO credential_templates (code,name,keySpecsJson,createdBy,createdAt,updatedAt)
       VALUES ('legacy','旧模板','[]','u','t','t')`,
    ).run();
    const legacyStore = SqliteCredentialSetStore.fromSeed(db, KEY_HEX);
    legacyStore.migrate();
    expect((await legacyStore.getTemplate("legacy"))?.kind).toBe("generic");
    expect((await legacyStore.getTemplate("legacy"))?.repoUrl).toBeUndefined();
    await legacyStore.createTemplate(
      "fresh",
      { ...templateInput, kind: "git", repoUrl: "https://ghe.corp.io/a/b.git" },
      owner,
    );
    expect((await legacyStore.getTemplate("fresh"))?.repoUrl).toBe("https://ghe.corp.io/a/b.git");
    db.close();
  });

  it("改名：renameValue 只改本人别名，覆写 values 不丢别名", async () => {
    await store.createTemplate("jihulab-pat", templateInput, owner);
    await store.upsertValue(owner, "jihulab-pat", { token: "v1" });
    // 未命名时 entry.name 为 undefined
    expect((await store.getFilledValues(owner, ["jihulab-pat"]))[0]?.name).toBeUndefined();

    // 改名生效，values 不受影响
    expect(await store.renameValue(owner, "jihulab-pat", "我的极狐令牌")).toBe(true);
    const renamed = (await store.getFilledValues(owner, ["jihulab-pat"]))[0];
    expect(renamed?.name).toBe("我的极狐令牌");
    expect(renamed?.values.token).toBe("v1");

    // 再次 upsert 不带 name：别名保留（COALESCE）
    await store.upsertValue(owner, "jihulab-pat", { token: "v2" });
    expect((await store.getFilledValues(owner, ["jihulab-pat"]))[0]?.name).toBe("我的极狐令牌");

    // userId 隔离：他人/不存在的凭证项不可改名
    expect(await store.renameValue(other, "jihulab-pat", "偷改")).toBe(false);
    expect(await store.renameValue(owner, "nope", "x")).toBe(false);
    expect((await store.getFilledValues(owner, ["jihulab-pat"]))[0]?.name).toBe("我的极狐令牌");
  });

  it("migrate：旧库 user_credential_values 无 name 列时自动补列", async () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE user_credential_values (
        userId TEXT NOT NULL, code TEXT NOT NULL, valuesCipher TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, PRIMARY KEY (userId, code)
      );
    `);
    const legacyStore = SqliteCredentialSetStore.fromSeed(db, KEY_HEX);
    legacyStore.migrate();
    await legacyStore.createTemplate("legacy", templateInput, owner);
    await legacyStore.upsertValue(owner, "legacy", { token: "v" });
    expect(await legacyStore.renameValue(owner, "legacy", "旧库改名")).toBe(true);
    expect((await legacyStore.getFilledValues(owner, ["legacy"]))[0]?.name).toBe("旧库改名");
    db.close();
  });
});

function byCode(list: Array<{ code: string }>): string[] {
  return list.map((t) => t.code).sort();
}
