import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_CODE_PATTERN,
  CredentialKeySpecSchema,
  CredentialTemplateInputSchema,
  parseCredentialCode,
} from "../../src/domain/credential.js";
import { resolveInjectionEnv, toEnvName } from "../../src/domain/credential-injection.js";

describe("toEnvName", () => {
  it("code 与 key 拼接为大写下划线名", () => {
    expect(toEnvName("jihulab-pat", "token")).toBe("JIHULAB_PAT_TOKEN");
  });

  it("非法字符转 _ 并压缩连续 _ 去首尾 _", () => {
    expect(toEnvName("aliyun__ak--prod", "access key")).toBe("ALIYUN_AK_PROD_ACCESS_KEY");
  });
});

describe("resolveInjectionEnv", () => {
  it("已配置的凭证展开为 <CODE>_<KEY> 平铺 + <CODE> 整体 JSON", () => {
    const { env, missing } = resolveInjectionEnv(
      [{ code: "jihulab-pat", values: { token: "t1", user: "u1" } }],
      ["jihulab-pat"],
    );
    expect(missing).toEqual([]);
    expect(env.JIHULAB_PAT_TOKEN).toBe("t1");
    expect(env.JIHULAB_PAT_USER).toBe("u1");
    expect(env.JIHULAB_PAT).toBe(JSON.stringify({ token: "t1", user: "u1" }));
    expect(Object.keys(env)).toHaveLength(3);
  });

  it("勾选但未配置 → _MISSING=1，不注入其他变量", () => {
    const { env, missing } = resolveInjectionEnv([], ["lvmh-key"]);
    expect(missing).toEqual(["lvmh-key"]);
    expect(env).toEqual({ LVMH_KEY_MISSING: "1" });
  });

  it("混合：命中的正常展开，未命中的标记缺失", () => {
    const { env, missing } = resolveInjectionEnv([{ code: "a", values: { k: "v" } }], ["a", "b"]);
    expect(missing).toEqual(["b"]);
    expect(env.A_K).toBe("v");
    expect(env.B_MISSING).toBe("1");
  });

  it("勾选顺序与重复 code：重复勾选不重复注入", () => {
    const { env, missing } = resolveInjectionEnv([{ code: "a", values: { k: "v" } }], ["a", "a"]);
    expect(missing).toEqual([]);
    expect(env.A_K).toBe("v");
  });
});

describe("凭证 code 与结构校验", () => {
  it("code 正则：合法/非法", () => {
    expect(CREDENTIAL_CODE_PATTERN.test("jihulab-pat")).toBe(true);
    expect(CREDENTIAL_CODE_PATTERN.test("aliyun_ak1")).toBe(true);
    expect(CREDENTIAL_CODE_PATTERN.test("-abc")).toBe(false);
    expect(CREDENTIAL_CODE_PATTERN.test("Abc")).toBe(false);
    expect(CREDENTIAL_CODE_PATTERN.test("a b")).toBe(false);
  });

  it("parseCredentialCode 拒绝非法值并报错", () => {
    expect(() => parseCredentialCode("BAD CODE")).toThrow(/code 非法/);
    expect(parseCredentialCode("ok-code")).toBe("ok-code");
  });

  it("keySpecs 键名仅允许字母数字下划线", () => {
    expect(CredentialKeySpecSchema.safeParse({ key: "access_token", label: "令牌" }).success).toBe(
      true,
    );
    expect(CredentialKeySpecSchema.safeParse({ key: "access token" }).success).toBe(false);
  });

  it("模板入参要求至少一个 keySpec", () => {
    expect(
      CredentialTemplateInputSchema.safeParse({
        code: "c1",
        name: "凭证",
        keySpecs: [{ key: "k" }],
      }).success,
    ).toBe(true);
    expect(
      CredentialTemplateInputSchema.safeParse({ code: "c1", name: "凭证", keySpecs: [] }).success,
    ).toBe(false);
  });
});
