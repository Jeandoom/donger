import { describe, expect, it } from "vitest";
import { ApiRouteGuard, type RouteGuardSpec } from "../../src/adapters/api-route-guard.js";
import type { Viewer } from "../../src/domain/access-policy.js";

const member: Viewer = { id: "u-alice", role: "user" };
const admin: Viewer = { id: "u-root", role: "admin" };

const specs: RouteGuardSpec[] = [
  { method: "GET", pattern: "/api/health", access: { kind: "public" } },
  { method: "POST", pattern: "/api/auth/login", access: { kind: "public" } },
  { method: "GET", pattern: "/api/usage", access: { kind: "authenticated" } },
  {
    method: "GET",
    pattern: "/api/conversations/:id/messages",
    access: { kind: "owner", resource: "conversation" },
    loadOwner: async (id) => (id === "conv-bob" ? { ownerId: "u-bob" } : undefined),
  },
  {
    method: "GET",
    pattern: "/api/users",
    access: { kind: "admin" },
  },
];

describe("ApiRouteGuard 构造期校验（fail-fast）", () => {
  it("owner 规则缺 loadOwner → 抛错", () => {
    expect(
      () =>
        new ApiRouteGuard([
          { method: "GET", pattern: "/api/x/:id", access: { kind: "owner", resource: "task" } },
        ]),
    ).toThrow(/loadOwner/);
  });

  it("非 owner 规则配 loadOwner → 抛错", () => {
    expect(
      () =>
        new ApiRouteGuard([
          {
            method: "GET",
            pattern: "/api/x",
            access: { kind: "authenticated" },
            loadOwner: async () => ({ ownerId: "u" }),
          },
        ]),
    ).toThrow(/仅 owner/);
  });

  it("owner 规则参数个数 ≠ 1 → 抛错", () => {
    expect(
      () =>
        new ApiRouteGuard([
          {
            method: "GET",
            pattern: "/api/x/:a/:b",
            access: { kind: "owner", resource: "task" },
            loadOwner: async () => ({ ownerId: "u" }),
          },
        ]),
    ).toThrow(/:id/);
  });

  it("重复登记 → 抛错", () => {
    expect(
      () =>
        new ApiRouteGuard([
          { method: "GET", pattern: "/api/x", access: { kind: "authenticated" } },
          { method: "GET", pattern: "/api/x", access: { kind: "authenticated" } },
        ]),
    ).toThrow(/重复登记/);
  });

  it("非法字符段 → 抛错（防前缀/通配模式混入）", () => {
    expect(
      () =>
        new ApiRouteGuard([
          { method: "GET", pattern: "/api/x/*", access: { kind: "authenticated" } },
        ]),
    ).toThrow(/非法路径段/);
  });
});

describe("ApiRouteGuard.check（运行期 fail-closed）", () => {
  const guard = new ApiRouteGuard(specs);

  it("未登记路由一律 404，即使已登录", async () => {
    const r = await guard.check({ method: "GET", pathname: "/api/nonexistent", viewer: admin });
    expect(r).toEqual({ ok: false, status: 404, error: "unknown endpoint" });
  });

  it("public 未登录放行", async () => {
    const r = await guard.check({ method: "GET", pathname: "/api/health", viewer: null });
    expect(r).toEqual({ ok: true });
  });

  it("authenticated 未登录 401", async () => {
    const r = await guard.check({ method: "GET", pathname: "/api/usage", viewer: null });
    expect(r).toEqual({ ok: false, status: 401, error: "请先登录" });
  });

  it("owner 资源不存在统一 404（防存在性泄漏）", async () => {
    const r = await guard.check({
      method: "GET",
      pathname: "/api/conversations/conv-ghost/messages",
      viewer: member,
    });
    expect(r).toEqual({ ok: false, status: 404, error: "not found" });
  });

  it("owner 他人资源 403，属主放行", async () => {
    const denied = await guard.check({
      method: "GET",
      pathname: "/api/conversations/conv-bob/messages",
      viewer: member,
    });
    expect(denied).toEqual({ ok: false, status: 403, error: expect.stringMatching(/forbidden/) });

    const allowed = await guard.check({
      method: "GET",
      pathname: "/api/conversations/conv-bob/messages",
      viewer: { id: "u-bob", role: "user" },
    });
    expect(allowed).toEqual({ ok: true });
  });

  it("owner 规则 admin 直通他人资源", async () => {
    const r = await guard.check({
      method: "GET",
      pathname: "/api/conversations/conv-bob/messages",
      viewer: admin,
    });
    expect(r).toEqual({ ok: true });
  });

  it("admin 端点对 member 403", async () => {
    const r = await guard.check({ method: "GET", pathname: "/api/users", viewer: member });
    expect(r).toEqual({ ok: false, status: 403, error: expect.stringMatching(/管理员/) });
  });

  it("参数段与查询串无关：精确匹配，不做前缀匹配", async () => {
    // /api/usage/extra 未登记 → 404（/api/usage 的登记不前缀外溢）
    const r = await guard.check({ method: "GET", pathname: "/api/usage/extra", viewer: member });
    expect(r).toEqual({ ok: false, status: 404, error: "unknown endpoint" });
  });

  it("方法不匹配视为未登记（404）", async () => {
    const r = await guard.check({ method: "DELETE", pathname: "/api/usage", viewer: member });
    expect(r).toEqual({ ok: false, status: 404, error: "unknown endpoint" });
  });
});
