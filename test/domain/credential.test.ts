import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_CODE_PATTERN,
  CredentialKeySpecSchema,
  CredentialTemplateInputSchema,
  GIT_PAT_KEY_SPECS,
  gitPatFromValues,
  parseCredentialCode,
  withGitPatKeySpecs,
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

describe("git PAT 固定键契约", () => {
  it("GIT_PAT_KEY_SPECS 固定为 access_token + user", () => {
    expect(GIT_PAT_KEY_SPECS.map((k) => k.key)).toEqual(["access_token", "user"]);
  });

  it("gitPatFromValues：按 access_token 取令牌，user 可选", () => {
    expect(gitPatFromValues({ access_token: "t1" })).toEqual({
      accessToken: "t1",
      user: undefined,
    });
    expect(gitPatFromValues({ access_token: "t1", user: "alice" })).toEqual({
      accessToken: "t1",
      user: "alice",
    });
    // 旧键名 token 不再被识别（2026-09-17 键名契约收口）
    expect(gitPatFromValues({ token: "t1" })).toBeUndefined();
    expect(gitPatFromValues(undefined)).toBeUndefined();
  });

  it("withGitPatKeySpecs：git 覆写为固定键（忽略自定义键名），generic 原样保留", () => {
    const git = withGitPatKeySpecs({
      code: "c1",
      name: "凭证",
      kind: "git" as const,
      keySpecs: [{ key: "whatever" }],
    });
    expect(git.keySpecs).toEqual(GIT_PAT_KEY_SPECS);

    const generic = {
      code: "c2",
      name: "凭证",
      kind: "generic" as const,
      keySpecs: [{ key: "api_key" }],
    };
    expect(withGitPatKeySpecs(generic)).toBe(generic);
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

  it("kind：缺省 generic；仅接受 generic/git", () => {
    const parsed = CredentialTemplateInputSchema.safeParse({
      code: "c1",
      name: "凭证",
      keySpecs: [{ key: "k" }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.kind).toBe("generic");

    const git = CredentialTemplateInputSchema.safeParse({
      code: "c1",
      name: "凭证",
      kind: "git",
      keySpecs: [{ key: "k" }],
    });
    expect(git.success).toBe(true);
    if (git.success) expect(git.data.kind).toBe("git");

    expect(
      CredentialTemplateInputSchema.safeParse({
        code: "c1",
        name: "凭证",
        kind: "ssh",
        keySpecs: [{ key: "k" }],
      }).success,
    ).toBe(false);
  });
});
