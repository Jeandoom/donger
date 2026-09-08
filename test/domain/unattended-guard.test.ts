import { describe, expect, it } from "vitest";
import { checkUnattendedSafety } from "../../src/domain/unattended-guard.js";

describe("checkUnattendedSafety", () => {
  it("含 *-accept 技能 → 不安全，reason 指出验收门技能", () => {
    const r = checkUnattendedSafety({
      name: "报告员",
      skills: ["report-execute", "report-accept", "其他"],
    });
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reason).toContain("report-accept");
    if (!r.safe) expect(r.reason).toContain("验收门");
  });

  it("无 accept 技能 → 安全", () => {
    const r = checkUnattendedSafety({ name: "执行者", skills: ["report-execute", "design"] });
    expect(r.safe).toBe(true);
  });

  it("空技能列表 → 安全", () => {
    expect(checkUnattendedSafety({ name: "空", skills: [] }).safe).toBe(true);
  });
});
