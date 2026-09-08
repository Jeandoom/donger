import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseFrontmatter, scanSkillPack } from "../../src/domain/skill-scan.js";

describe("parseFrontmatter", () => {
  it("解析 name/description/allowed-tools", () => {
    const md = `---\nname: my-skill\ndescription: "做某事"\nallowed-tools: Read, Write, Bash\n---\n# 正文`;
    expect(parseFrontmatter(md)).toEqual({
      name: "my-skill",
      description: "做某事",
      allowedTools: ["Read", "Write", "Bash"],
    });
  });

  it("无 frontmatter 返回空对象", () => {
    expect(parseFrontmatter("# 仅正文")).toEqual({});
  });

  it("allowed-tools 单值也成数组", () => {
    const md = `---\nname: s\ndescription: d\nallowed-tools: Read\n---\n`;
    expect(parseFrontmatter(md).allowedTools).toEqual(["Read"]);
  });

  it("allowed-tools 支持空格分隔", () => {
    const md = `---\nname: tools\ndescription: d\nallowed-tools: Bash Read\n---\n`;
    expect(parseFrontmatter(md).allowedTools).toEqual(["Bash", "Read"]);
  });

  it("解析 | 多行 description", () => {
    const md = `---\nname: multiline\ndescription: |\n  第一行描述\n  第二行描述\nallowed-tools: Read\n---\n正文`;
    expect(parseFrontmatter(md)).toEqual({
      name: "multiline",
      description: "第一行描述\n第二行描述",
      allowedTools: ["Read"],
    });
  });
});

describe("scanSkillPack", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scan-"));
  });

  function writeSkill(slug: string, skill: string, fm: string) {
    const p = join(dir, slug, "skills", skill);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "SKILL.md"), fm);
  }

  it("扫描出 skills + plugin.json", () => {
    writeSkill("demo", "alpha", `---\nname: alpha\ndescription: "a"\n---\n# alpha`);
    mkdirSync(join(dir, "demo", ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(dir, "demo", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", description: "d" }),
    );
    writeFileSync(
      join(dir, "demo", "donger.manifest.json"),
      JSON.stringify({
        schema: 1,
        credentials: [{ key: "K", label: "K", required: true, secret: true }],
      }),
    );
    const result = scanSkillPack(join(dir, "demo"));
    expect(result.packMeta.name).toBe("demo");
    expect(result.skills.map((s) => s.name)).toEqual(["alpha"]);
  });

  it("无 plugin.json 时 packMeta.name 取目录名", () => {
    writeSkill("lonely", "beta", `---\nname: beta\ndescription: "b"\n---\n`);
    const result = scanSkillPack(join(dir, "lonely"));
    expect(result.packMeta.name).toBe("lonely");
    expect(result.skills[0]?.name).toBe("beta");
  });

  it("跳过 node_modules / .git 目录", () => {
    writeSkill("demo", "alpha", `---\nname: alpha\ndescription: "a"\n---\n`);
    const nm = join(dir, "demo", "node_modules", "x", "skills", "y");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "SKILL.md"), `---\nname: noise\ndescription: n\n---\n`);
    const result = scanSkillPack(join(dir, "demo"));
    expect(result.skills.map((s) => s.name)).toEqual(["alpha"]);
  });
});
