import { describe, expect, it } from "vitest";
import {
  AGENT_PERMISSION_MODES,
  AgentPermissionModeSchema,
  DEFAULT_PERMISSION_MODE,
  resolvePermissionMode,
  resolveTurnPermissionMode,
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

describe("resolveTurnPermissionMode（2026-10-14 拍板：工作流配置为准）", () => {
  it("消息级覆盖最高优先：无人值守也按携带值执行", () => {
    expect(
      resolveTurnPermissionMode({
        messageMode: "full_access",
        unattended: true,
        conversationMode: "ask_before_change",
        agentMode: "ask_before_change",
      }),
    ).toBe("full_access");
  });

  it("无消息级覆盖时维持无人值守缺省（变更前问询），会话/智能体配置不抬档", () => {
    expect(
      resolveTurnPermissionMode({
        unattended: true,
        conversationMode: "full_access",
        agentMode: "full_access",
      }),
    ).toBe("ask_before_change");
    expect(resolveTurnPermissionMode({ unattended: true })).toBe("ask_before_change");
  });

  it("交互式轮走会话覆盖 > 智能体默认 > 系统缺省", () => {
    expect(resolveTurnPermissionMode({ unattended: false, conversationMode: "risk_guard" })).toBe(
      "risk_guard",
    );
    expect(resolveTurnPermissionMode({ unattended: false, agentMode: "full_access" })).toBe(
      "full_access",
    );
    expect(resolveTurnPermissionMode({ unattended: false })).toBe(DEFAULT_PERMISSION_MODE);
  });
});
