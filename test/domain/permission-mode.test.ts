import { describe, expect, it } from "vitest";
import {
  AGENT_PERMISSION_MODES,
  AgentPermissionModeSchema,
  DEFAULT_PERMISSION_MODE,
  resolvePermissionMode,
  resolveUnattendedPermissionMode,
} from "../../src/domain/permission-mode.js";

describe("resolvePermissionMode", () => {
  it("会话覆盖 > 智能体默认", () => {
    expect(resolvePermissionMode("full_access", "ask_before_change")).toBe("full_access");
    expect(resolvePermissionMode("ask_before_change", "full_access")).toBe("ask_before_change");
  });

  it("会话未覆盖时跟随智能体默认", () => {
    expect(resolvePermissionMode(undefined, "full_access")).toBe("full_access");
    expect(resolvePermissionMode(undefined, "risk_guard")).toBe("risk_guard");
  });

  it("三模式枚举含 risk_guard（2026-10-13 权限模式轮）", () => {
    expect(AGENT_PERMISSION_MODES).toContain("risk_guard");
    expect(AgentPermissionModeSchema.safeParse("risk_guard").success).toBe(true);
    expect(AgentPermissionModeSchema.safeParse("unknown_mode").success).toBe(false);
  });

  it("都未配置时用系统缺省（变更前问询）", () => {
    expect(resolvePermissionMode()).toBe(DEFAULT_PERMISSION_MODE);
    expect(resolvePermissionMode(undefined, undefined)).toBe("ask_before_change");
  });
});

describe("resolveUnattendedPermissionMode", () => {
  it("无人值守恒为变更前问询（full_access 仅限交互式会话）", () => {
    expect(resolveUnattendedPermissionMode()).toBe("ask_before_change");
  });
});
