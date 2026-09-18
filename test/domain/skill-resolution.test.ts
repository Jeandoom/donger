import { describe, expect, it } from "vitest";
import type { PackSkill, SkillPack } from "../../src/domain/skill-pack.js";
import { resolveActiveSkills } from "../../src/domain/skill-resolution.js";

function pack(over: Partial<SkillPack> = {}): SkillPack {
  return {
    id: "p1",
    userId: "u1",
    slug: "demo",
    name: "demo",
    source: { kind: "paste" },
    installedPath: ".skills/demo",
    enabled: true,
    builtin: false,
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}
function skill(over: Partial<PackSkill> = {}): PackSkill {
  return {
    id: "s1",
    userId: "u1",
    packId: "p1",
    name: "alpha",
    description: "d",
    relativePath: "skills/alpha/SKILL.md",
    enabled: true,
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}

describe("resolveActiveSkills", () => {
  it("启用 pack+skill → 进 pluginPaths/白名单", () => {
    const r = resolveActiveSkills([pack()], new Map([["p1", [skill()]]]), (p) => p.installedPath);
    expect(r.pluginPaths).toEqual([".skills/demo"]);
    expect(r.whitelist).toEqual(["demo:alpha"]);
  });

  it("停用 pack 不进任何集合", () => {
    const r = resolveActiveSkills(
      [pack({ enabled: false })],
      new Map([["p1", [skill()]]]),
      (p) => p.installedPath,
    );
    expect(r.pluginPaths).toEqual([]);
    expect(r.whitelist).toEqual([]);
  });

  it("停用单个 skill → pack 路径在，但该 skill 不进白名单", () => {
    const r = resolveActiveSkills(
      [pack()],
      new Map([["p1", [skill(), skill({ id: "s2", name: "beta", enabled: false })]]]),
      (p) => p.installedPath,
    );
    expect(r.pluginPaths).toEqual([".skills/demo"]);
    expect(r.whitelist).toEqual(["demo:alpha"]);
  });

  it("pluginPaths 去重（同目录多 pack）", () => {
    const r = resolveActiveSkills(
      [pack(), pack({ id: "p2", name: "demo2", slug: "demo2", installedPath: ".skills/demo" })],
      new Map([
        ["p1", [skill()]],
        ["p2", [skill({ id: "s2", packId: "p2" })]],
      ]),
      (p) => p.installedPath,
    );
    expect(r.pluginPaths).toEqual([".skills/demo"]);
  });
});
