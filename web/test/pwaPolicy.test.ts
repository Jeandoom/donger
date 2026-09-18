import { describe, expect, it } from "vitest";
import { PWA_OPTIONS } from "../pwa.config";

describe("PWA policy", () => {
  it("uses prompt updates and standalone display", () => {
    expect(PWA_OPTIONS.registerType).toBe("prompt");
    expect(PWA_OPTIONS.manifest?.display).toBe("standalone");
  });

  it("does not define business runtime caches", () => {
    expect(PWA_OPTIONS.workbox?.runtimeCaching).toEqual([]);
  });

  it.each([
    "/api/conversations",
    "/api/conversations/c1/stream",
    "/uploads/u/a.png",
  ])("excludes %s from navigation fallback", (path) => {
    const denylist = PWA_OPTIONS.workbox?.navigateFallbackDenylist ?? [];
    expect(denylist.some((pattern) => pattern.test(path))).toBe(true);
  });
});
