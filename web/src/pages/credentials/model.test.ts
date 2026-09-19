import { describe, expect, it } from "vitest";
import { filterCredentialRows, mergeCredentialRows, validateCredentialCode } from "./model";

const tpl = (code: string, keys: string[], extra = {}) => ({
  code,
  name: `模板 ${code}`,
  keySpecs: keys.map((key) => ({ key })),
  createdBy: "u1",
  updatedAt: "2026-01-01",
  ...extra,
});

const mine = (code: string, filled: string[], missing: string[]) => ({
  code,
  name: `我的 ${code}`,
  keySpecs: [...filled, ...missing].map((key) => ({ key })),
  filledKeys: filled,
  missingKeys: missing,
  updatedAt: "2026-01-02",
});

describe("mergeCredentialRows", () => {
  it("合并我的值与模板，待补全排前", () => {
    const rows = mergeCredentialRows(
      [mine("a-cred", ["k1"], ["k2"]), mine("c-cred", ["k1"], [])],
      [tpl("a-cred", ["k1", "k2"]), tpl("b-tpl", ["k9"]), tpl("c-cred", ["k1"])],
    );
    expect(rows.map((r) => r.code)).toEqual(["a-cred", "b-tpl", "c-cred"]);
    expect(rows[0]).toMatchObject({ templateOnly: false, missingKeys: ["k2"] });
    expect(rows[1]).toMatchObject({ templateOnly: true, filledKeys: [], missingKeys: ["k9"] });
    expect(rows[2]).toMatchObject({ templateOnly: false, missingKeys: [] });
  });

  it("模板删除后值条目标记 orphan", () => {
    const rows = mergeCredentialRows([mine("ghost", [], [])], []);
    expect(rows[0]?.orphan).toBe(true);
    expect(rows[0]?.missingKeys).toEqual([]);
  });

  it("别名优先展示", () => {
    const rows = mergeCredentialRows(
      [{ ...mine("a", ["k"], []), name: "别名", alias: "别名" }],
      [tpl("a", ["k"])],
    );
    expect(rows[0]?.name).toBe("别名");
  });
});

describe("filterCredentialRows", () => {
  const rows = mergeCredentialRows(
    [mine("alpha", ["k1"], ["k2"])],
    [tpl("alpha", ["k1", "k2"]), tpl("beta", ["k3"])],
  );

  it("状态分段", () => {
    expect(filterCredentialRows(rows, "todo", "").map((r) => r.code)).toEqual(["alpha", "beta"]);
    expect(filterCredentialRows(rows, "ready", "").map((r) => r.code)).toEqual([]);
  });

  it("关键词匹配 code 与名称，大小写不敏感", () => {
    expect(filterCredentialRows(rows, "all", "ALPHA")).toHaveLength(1);
    expect(filterCredentialRows(rows, "all", "模板 beta")).toHaveLength(1);
    expect(filterCredentialRows(rows, "all", "nope")).toHaveLength(0);
  });
});

describe("validateCredentialCode", () => {
  it("合法 code", () => {
    expect(validateCredentialCode("jihulab-pat")).toBeNull();
    expect(validateCredentialCode("a1_b2")).toBeNull();
  });

  it("非法 code", () => {
    expect(validateCredentialCode("")).not.toBeNull();
    expect(validateCredentialCode("-lead")).not.toBeNull();
    expect(validateCredentialCode("Upper")).not.toBeNull();
    expect(validateCredentialCode("has space")).not.toBeNull();
  });
});
