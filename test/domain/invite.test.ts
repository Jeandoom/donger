import { describe, expect, it } from "vitest";
import {
  buildInvite,
  inviteBlockReason,
  isEmailDomainAllowed,
  isValidEmail,
  normalizeEmail,
  passwordPolicyError,
} from "../../src/domain/invite.js";

describe("normalizeEmail / isValidEmail", () => {
  it("去空白并小写化", () => {
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
  });

  it("基础格式校验", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("a b@c.co")).toBe(false);
  });
});

describe("isEmailDomainAllowed", () => {
  it("白名单命中（大小写不敏感）", () => {
    expect(isEmailDomainAllowed("a@Example.com", new Set(["example.com"]))).toBe(true);
  });

  it("未命中 → false", () => {
    expect(isEmailDomainAllowed("a@other.com", new Set(["example.com"]))).toBe(false);
  });

  it("空白名单 → false（关闭无邀请自助注册）", () => {
    expect(isEmailDomainAllowed("a@example.com", new Set())).toBe(false);
  });

  it(".domain 条目覆盖子域", () => {
    const wl = new Set([".corp.cn"]);
    expect(isEmailDomainAllowed("a@corp.cn", wl)).toBe(true);
    expect(isEmailDomainAllowed("a@mail.corp.cn", wl)).toBe(true);
    expect(isEmailDomainAllowed("a@notcorp.cn", wl)).toBe(false);
  });
});

describe("passwordPolicyError", () => {
  it("过短/缺字母/缺数字 → 报错", () => {
    expect(passwordPolicyError("a1")).not.toBeNull();
    expect(passwordPolicyError("12345678")).not.toBeNull();
    expect(passwordPolicyError("abcdefgh")).not.toBeNull();
  });

  it("字母+数字 8 位以上 → 通过", () => {
    expect(passwordPolicyError("abcd1234")).toBeNull();
  });
});

describe("inviteBlockReason / buildInvite", () => {
  it("禁用/过期/用尽分别给出原因", () => {
    const base = buildInvite({ createdBy: "u1", expiresInDays: 7, maxUses: 1 });
    expect(inviteBlockReason(base, new Date())).toBeNull();
    expect(inviteBlockReason({ ...base, disabled: true }, new Date())).toBe("邀请链接已被禁用");
    expect(inviteBlockReason({ ...base, expiresAt: new Date(0).toISOString() }, new Date())).toBe(
      "邀请链接已过期",
    );
    expect(inviteBlockReason({ ...base, usedCount: 1 }, new Date())).toBe("邀请链接使用次数已用完");
  });

  it("buildInvite 参数钳制：天数 1–30、次数 1–100", () => {
    expect(() => buildInvite({ createdBy: "u", expiresInDays: 99, maxUses: 1 })).not.toThrow();
    const invite = buildInvite({ createdBy: "u", expiresInDays: 99, maxUses: 500 });
    expect(invite.token.length).toBe(64);
    const span = new Date(invite.expiresAt).getTime() - new Date(invite.createdAt).getTime();
    expect(span).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000 + 1000);
  });
});
