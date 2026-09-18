import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureSdkPluginLayout,
  materializeSharedSkillPlugin,
} from "../../src/util/sdk-plugin-layout.js";

function writeSkill(root: string, relativePath: string, content = "---\nname: demo\n---\n"): void {
  const path = join(root, relativePath);
  const parent = path.slice(0, path.lastIndexOf("\\"));
  mkdirSync(parent, { recursive: true });
  writeFileSync(path, content);
}

describe("ensureSdkPluginLayout", () => {
  it("将多级技能目录复制为标准 plugin，并保留技能资源", () => {
    const root = mkdtempSync(join(tmpdir(), "sdk-plugin-"));
    writeSkill(
      root,
      "skills/storage/sls/alibabacloud-sls-query/SKILL.md",
      "---\nname: alibabacloud-sls-query\ndescription: query\n---\n",
    );
    writeSkill(root, "skills/storage/sls/alibabacloud-sls-query/references/example.md", "ref");

    const pluginPath = ensureSdkPluginLayout(root, "alibabacloud-aiops-skills");
    expect(pluginPath).toBe(join(root, ".donger-sdk-plugin"));
    expect(existsSync(join(pluginPath, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(
      readFileSync(
        join(pluginPath, "skills", "alibabacloud-sls-query", "references", "example.md"),
        "utf8",
      ),
    ).toBe("ref");
    expect(ensureSdkPluginLayout(root, "alibabacloud-aiops-skills")).toBe(pluginPath);
  });

  it("多级 pack 顶层 scripts/ 共享运行库随插件物化（复盘 P2-10）", () => {
    const root = mkdtempSync(join(tmpdir(), "sdk-plugin-"));
    writeSkill(
      root,
      "skills/tools/gitlaber/SKILL.md",
      "---\nname: gitlaber\ndescription: x\n---\n",
    );
    const credDir = join(root, "scripts", "credentials");
    mkdirSync(credDir, { recursive: true });
    writeFileSync(join(credDir, "__init__.py"), "");
    writeFileSync(
      join(credDir, "store.py"),
      "def get_credential(prefix, key):\n    raise NotImplementedError\n",
    );

    const pluginPath = ensureSdkPluginLayout(root, "copilot-skills");
    expect(existsSync(join(pluginPath, "scripts", "credentials", "store.py"))).toBe(true);
    // marker 升版后重复调用仍命中缓存且不被删除
    expect(ensureSdkPluginLayout(root, "copilot-skills")).toBe(pluginPath);
    expect(existsSync(join(pluginPath, "scripts", "credentials", "store.py"))).toBe(true);
  });

  it("共享访问者目录同样物化 scripts/ 共享运行库", () => {
    const source = mkdtempSync(join(tmpdir(), "sdk-plugin-source-"));
    const target = mkdtempSync(join(tmpdir(), "sdk-plugin-target-"));
    writeSkill(source, "skills/keep/SKILL.md", "---\nname: keep\ndescription: x\n---\n");
    mkdirSync(join(source, "scripts", "credentials"), { recursive: true });
    writeFileSync(join(source, "scripts", "credentials", "__init__.py"), "");

    const pluginPath = materializeSharedSkillPlugin(source, "demo", ["keep"], target);
    expect(pluginPath).toBe(target);
    expect(existsSync(join(target, "scripts", "credentials", "__init__.py"))).toBe(true);
  });

  it("标准单级 plugin 直接复用原目录", () => {
    const root = mkdtempSync(join(tmpdir(), "sdk-plugin-"));
    writeSkill(root, "skills/demo/SKILL.md");
    expect(ensureSdkPluginLayout(root, "demo")).toBe(root);
  });

  it("共享时只复制指定技能到访问者目录", () => {
    const source = mkdtempSync(join(tmpdir(), "sdk-plugin-source-"));
    const target = mkdtempSync(join(tmpdir(), "sdk-plugin-target-"));
    writeSkill(source, "skills/keep/SKILL.md", "---\nname: keep\n---\n");
    writeSkill(source, "skills/drop/SKILL.md", "---\nname: drop\n---\n");

    const pluginPath = materializeSharedSkillPlugin(source, "demo", ["keep"], target);
    expect(pluginPath).toBe(target);
    expect(existsSync(join(target, "skills", "keep", "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, "skills", "drop", "SKILL.md"))).toBe(false);
  });
});
