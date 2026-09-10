import { describe, expect, it } from "vitest";
import { checkUnattendedSafety } from "../../src/domain/unattended-guard.js";

describe("checkUnattendedSafety", () => {
  it("启用验收门 → 不安全，reason 指出验收门与修复建议", () => {
    const r = checkUnattendedSafety({ name: "报告员", acceptanceGate: true });
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reason).toContain("报告员");
    if (!r.safe) expect(r.reason).toContain("acceptanceGate");
    if (!r.safe) expect(r.reason).toContain("验收门");
  });

  it("未启用验收门 → 安全（requiresDesign 方案门由无人值守执行策略运行时约束）", () => {
    const r = checkUnattendedSafety({ name: "执行者", acceptanceGate: false });
    expect(r.safe).toBe(true);
  });
});
