import { describe, expect, it } from "vitest";
import type { ModuleConfigStore } from "../../src/ports/module-config-store.js";
import type { UserStore } from "../../src/ports/user-store.js";
import { backfillSetupCompletedFlag } from "../../src/util/setup-completed-backfill.js";

function fakeUsers(hasAnyAdmin: boolean): Pick<UserStore, "hasAnyAdmin"> {
  return { hasAnyAdmin: async () => hasAnyAdmin };
}

function fakeConfigs(initialFlags: Record<string, string> = {}) {
  const flags = { ...initialFlags };
  return {
    getFlag: (key: string) => flags[key],
    setFlag: (key: string, value: string) => {
      flags[key] = value;
    },
    flags,
  } satisfies Pick<ModuleConfigStore, "getFlag" | "setFlag"> & { flags: Record<string, string> };
}

describe("backfillSetupCompletedFlag（spec 2026-09-21-user-management-design §2.3）", () => {
  it("有 admin 且无标记 → 补写并返回 true", async () => {
    const configs = fakeConfigs();
    expect(await backfillSetupCompletedFlag(fakeUsers(true), configs)).toBe(true);
    expect(configs.getFlag("setup_completed")).toBeTruthy();
  });

  it("已有标记 → 不动（幂等）", async () => {
    const configs = fakeConfigs({ setup_completed: "2026-09-01T00:00:00.000Z" });
    expect(await backfillSetupCompletedFlag(fakeUsers(true), configs)).toBe(false);
    expect(configs.getFlag("setup_completed")).toBe("2026-09-01T00:00:00.000Z");
  });

  it("无 admin（尚未引导）→ 不动，不误写标记", async () => {
    const configs = fakeConfigs();
    expect(await backfillSetupCompletedFlag(fakeUsers(false), configs)).toBe(false);
    expect(configs.getFlag("setup_completed")).toBeUndefined();
  });
});
