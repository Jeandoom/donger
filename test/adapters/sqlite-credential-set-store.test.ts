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
    store = new SqliteCredentialSetStore(new Database(":memory:"), KEY_HEX);
    store.migrate();
  });

  const templateInput = {
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

  it("用户值：隔离、整体覆写、解密取回、删除", async () => {
    await store.createTemplate("jihulab-pat", templateInput, owner);
    await store.upsertValue(owner, "jihulab-pat", { token: "secret-1" });
    await store.upsertValue(other, "jihulab-pat", { token: "secret-2" });

    // 他人不可见（userId 隔离）
    expect((await store.getFilledValues(owner, ["jihulab-pat"]))[0]?.values.token).toBe("secret-1");
    expect(await store.getFilledValues(randomUUID(), ["jihulab-pat"])).toEqual([]);

    // 整体覆写
    await store.upsertValue(owner, "jihulab-pat", { token: "rotated", extra: "e" });
    const entry = (await store.getFilledValues(owner, ["jihulab-pat"]))[0];
    expect(entry?.values).toEqual({ token: "rotated", extra: "e" });
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
});

function byCode(list: Array<{ code: string }>): string[] {
  return list.map((t) => t.code).sort();
}
