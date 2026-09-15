import { describe, expect, it } from "vitest";
import { isAdminExternalId } from "../../src/domain/user.js";

describe("isAdminExternalId", () => {
  const whitelist = new Set(["ding-staff-1", "github:8888", "cli-admin"]);

  it("裸 externalId 命中（全平台生效，向后兼容）", () => {
    expect(isAdminExternalId(whitelist, "dingtalk", "ding-staff-1")).toBe(true);
    expect(isAdminExternalId(whitelist, "github", "ding-staff-1")).toBe(true);
  });

  it("provider:externalId 前缀命中", () => {
    expect(isAdminExternalId(whitelist, "github", "8888")).toBe(true);
  });

  it("前缀条目不跨平台生效", () => {
    expect(isAdminExternalId(whitelist, "dingtalk", "8888")).toBe(false);
  });

  it("未命中 → false", () => {
    expect(isAdminExternalId(whitelist, "github", "9999")).toBe(false);
    expect(isAdminExternalId(whitelist, "dingtalk", "staff-miss")).toBe(false);
  });
});
