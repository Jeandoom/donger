import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditAgentSkillAvailability } from "../../src/domain/skill-availability.js";
import type { SkillPack } from "../../src/domain/skill-pack.js";

/** 在 tmp 下造一个标准插件布局 pack：skills/<name>/SKILL.md */
function makePackPack(dir: string, pluginName: string, skillNames: string[]): SkillPack {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: pluginName, version: "0.1.0" }),
  );
  for (const name of skillNames) {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(
      join(dir, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name}\n---\n`,
    );
  }
  return {
    id: `${pluginName}-id`,
    userId: "owner",
    slug: pluginName,
    name: pluginName,
    source: { kind: "paste" },
    installedPath: dir,
    enabled: true,
    builtin: false,
    createdAt: "t",
    updatedAt: "t",
  };
}

describe("auditAgentSkillAvailability", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-availability-"));
  const owner = { id: "owner", homeDir: join(dir, "home") };

  it("技能齐备 → 无缺失", async () => {
    const packDir = join(dir, "ok-pack");
    const pack = makePackPack(packDir, "ok-pack", ["alpha", "beta"]);
    const missing = await auditAgentSkillAvailability(
      async () => [pack],
      { skills: ["ok-pack:alpha", "ok-pack:beta"], defaultSkill: "ok-pack:alpha" },
      owner,
    );
    expect(missing).toEqual([]);
  });

  it("pack 不存在 / 已停用 / 技能改名 / 格式非法 → 全部记缺失", async () => {
    const packDir = join(dir, "live-pack");
    const pack = makePackPack(packDir, "live-pack", ["alpha"]);
    const disabled = { ...makePackPack(join(dir, "off-pack"), "off-pack", ["x"]), enabled: false };
    const missing = await auditAgentSkillAvailability(
      async () => [pack, disabled],
      {
        skills: [
          "live-pack:alpha", // 齐备
          "live-pack:ghost", // 改名/删除
          "no-pack:x", // pack 不存在
          "off-pack:x", // pack 停用
          "malformed", // 无 pack 前缀
        ],
      },
      owner,
    );
    expect(missing).toEqual(["malformed", "live-pack:ghost", "no-pack:x", "off-pack:x"]);
  });

  it("声明为空 → 不扫描直接返回空", async () => {
    const missing = await auditAgentSkillAvailability(async () => [], { skills: [] }, owner);
    expect(missing).toEqual([]);
  });
});
