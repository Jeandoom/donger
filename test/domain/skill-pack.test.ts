import { describe, expect, it } from "vitest";
import type { PackSkill, SkillPack, SkillPackSource } from "../../src/domain/skill-pack.js";

describe("skill-pack 类型", () => {
  it("可构造一个用户 git Pack", () => {
    const src: SkillPackSource = { kind: "git", url: "https://github.com/x/y", ref: "main" };
    const pack: SkillPack = {
      id: "p1",
      userId: "u1",
      slug: "y",
      name: "y",
      source: src,
      installedPath: ".skills/y",
      enabled: true,
      builtin: false,
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    };
    expect(pack.source.kind).toBe("git");
  });

  it("预装 Pack 用 builtin 来源", () => {
    const pack: SkillPack = {
      id: "p2",
      userId: "u1",
      slug: "superpowers",
      name: "superpowers",
      source: { kind: "builtin" },
      installedPath: "/abs/skills/superpowers",
      enabled: true,
      builtin: true,
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    };
    expect(pack.builtin).toBe(true);
  });

  it("PackSkill 形状", () => {
    const s: PackSkill = {
      id: "s1",
      userId: "u1",
      packId: "p1",
      name: "brainstorming",
      description: "d",
      relativePath: "skills/brainstorming/SKILL.md",
      enabled: true,
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    };
    expect(s.name).toBe("brainstorming");
  });
});
