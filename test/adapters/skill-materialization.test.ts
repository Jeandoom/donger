import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractLocalAssetRefs,
  materializeWhitelistedSkills,
  skillDocIssues,
} from "../../src/util/skill-materialization.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function makePack(skillBody: string, files: Record<string, string> = {}): string {
  dir = mkdtempSync(join(tmpdir(), "donger-skm-"));
  const pack = join(dir, "pack");
  const skillDir = join(pack, "skills", "demo");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), skillBody, "utf8");
  for (const [rel, content] of Object.entries(files)) {
    const p = join(skillDir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content, "utf8");
  }
  mkdirSync(join(pack, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(pack, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "demo-pack" }),
    "utf8",
  );
  return pack;
}

const PLUGIN_ROOT = "C:\\nonexistent\\plugins";

describe("extractLocalAssetRefs", () => {
  it("提取固定前缀目录引用，去重并去尾部标点", () => {
    const refs = extractLocalAssetRefs(
      [
        "跑 `scripts/homedb_ssh.py \"cmd\"`，再读 assets/logo.png。",
        "参考 references/api.md、templates/x.tmpl。",
        "外链 https://x.com/scripts/fake.js 不算本地引用。",
        "无后缀目录 scripts 单独出现不匹配。",
      ].join("\n"),
    );
    expect(refs).toContain("scripts/homedb_ssh.py");
    expect(refs).toContain("assets/logo.png");
    expect(refs).toContain("references/api.md");
    expect(refs).toContain("templates/x.tmpl");
    expect(refs.some((r) => r.includes("fake.js"))).toBe(false);
  });
});

describe("skillDocIssues", () => {
  it("description 超 1024 字节：报丢弃线", () => {
    const pack = makePack("---\nname: demo\ndescription: ok\n---\n正文");
    const issues = skillDocIssues(join(pack, "skills", "demo", "SKILL.md"), "长".repeat(600));
    expect(issues.some((i) => i.includes("1024"))).toBe(true);
  });

  it("引用缺失：报缺失清单", () => {
    const pack = makePack("正文 引用 scripts/homedb_ssh.py 与 assets/x.png\n");
    const issues = skillDocIssues(join(pack, "skills", "demo", "SKILL.md"), "ok");
    expect(issues.some((i) => i.includes("scripts/homedb_ssh.py"))).toBe(true);
    expect(issues.some((i) => i.includes("assets/x.png"))).toBe(true);
  });

  it("引用存在且描述合规：无问题", () => {
    const pack = makePack("引用 scripts/run.sh\n", {
      "scripts/run.sh": "echo hi\n",
    });
    const issues = skillDocIssues(join(pack, "skills", "demo", "SKILL.md"), "ok");
    expect(issues).toEqual([]);
  });
});

describe("materializeWhitelistedSkills 完整性校验", () => {
  it("引用缺失的技能跳过物化并回传告警", () => {
    const pack = makePack('---\nname: demo\ndescription: "d"\n---\n引用 scripts/missing.py\n');
    const home = join(dir, "home-skills");
    mkdirSync(home, { recursive: true });
    const warnings = materializeWhitelistedSkills(
      ["demo-pack:demo"],
      [pack, PLUGIN_ROOT],
      home,
    );
    expect(warnings.some((w) => w.includes("demo") && w.includes("scripts/missing.py"))).toBe(
      true,
    );
    expect(existsSync(join(home, "demo"))).toBe(false);
  });

  it("健康技能正常物化（无告警）", () => {
    const pack = makePack('---\nname: demo\ndescription: "d"\n---\n引用 scripts/run.sh\n', {
      "scripts/run.sh": "echo",
    });
    const home = join(dir, "home-skills");
    mkdirSync(home, { recursive: true });
    const warnings = materializeWhitelistedSkills(["demo-pack:demo"], [pack], home);
    expect(warnings).toEqual([]);
    expect(existsSync(join(home, "demo", "SKILL.md"))).toBe(true);
  });
});
