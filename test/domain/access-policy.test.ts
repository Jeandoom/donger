import { describe, expect, it } from "vitest";
import { canAccess, type Viewer } from "../../src/domain/access-policy.js";

const member: Viewer = { id: "u-alice", role: "user" };
const admin: Viewer = { id: "u-root", role: "admin" };

describe("canAccess", () => {
  it("public：未登录也放行", () => {
    expect(canAccess(null, { kind: "public" })).toBe(true);
  });

  it("authenticated：登录放行，未登录拒绝", () => {
    expect(canAccess(null, { kind: "authenticated" })).toBe(false);
    expect(canAccess(member, { kind: "authenticated" })).toBe(true);
  });

  it("owner：仅属主放行", () => {
    const rule = { kind: "owner" as const, resource: "conversation" as const };
    expect(canAccess(member, rule, "u-alice")).toBe(true);
    expect(canAccess(member, rule, "u-bob")).toBe(false);
  });

  it("owner：admin 直通（资源存在性由守卫 loadOwner 先行 404，判定层不重复处理）", () => {
    const rule = { kind: "owner" as const, resource: "task" as const };
    expect(canAccess(admin, rule, "u-bob")).toBe(true);
    expect(canAccess(admin, rule, undefined)).toBe(true);
  });

  it("owner：属主未知不放行（fail-closed）", () => {
    const rule = { kind: "owner" as const, resource: "task" as const };
    expect(canAccess(member, rule, undefined)).toBe(false);
  });

  it("admin：仅 admin 放行", () => {
    expect(canAccess(member, { kind: "admin" })).toBe(false);
    expect(canAccess(admin, { kind: "admin" })).toBe(true);
    expect(canAccess(null, { kind: "admin" })).toBe(false);
  });
});
