import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { scanSkillPack } from "../domain/skill-scan.js";

type LayoutMarker = {
  version: 1;
  skills: Array<{ relativePath: string; name: string; modifiedAt: number; size: number }>;
};

/**
 * 将多级 skills 仓库适配为 Claude Agent SDK 可发现的标准 plugin 目录。
 * 原仓库保留不动，生成目录只复制每个技能目录（包括 references/assets 等资源）。
 */
export function ensureSdkPluginLayout(packDir: string, pluginName: string): string {
  if (!existsSync(packDir)) return packDir;
  let scanned: ReturnType<typeof scanSkillPack>;
  try {
    scanned = scanSkillPack(packDir);
  } catch {
    return packDir;
  }
  const directLayout = scanned.skills.every((skill) => /^skills\/[^/]+\/SKILL\.md$/.test(skill.relativePath));
  if (directLayout || scanned.skills.length === 0) return packDir;

  const generatedDir = join(packDir, ".donger-sdk-plugin");
  const markerPath = join(generatedDir, ".layout.json");
  const marker = makeMarker(packDir, scanned.skills);
  if (sameMarker(markerPath, marker)) return generatedDir;

  rmSync(generatedDir, { recursive: true, force: true });
  const targetSkillsDir = join(generatedDir, "skills");
  mkdirSync(targetSkillsDir, { recursive: true });
  const usedNames = new Set<string>();
  for (const skill of scanned.skills) {
    const sourceDir = dirname(join(packDir, skill.relativePath));
    const targetName = uniqueSkillDirectoryName(skill.name, usedNames);
    cpSync(sourceDir, join(targetSkillsDir, targetName), { recursive: true });
  }
  mkdirSync(join(generatedDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(generatedDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: pluginName, version: "0.1.0" }),
  );
  writeFileSync(markerPath, JSON.stringify(marker));
  return generatedDir;
}

/** 将共享智能体实际选中的技能复制到访问者会话目录，避免挂载分享者整个用户目录。 */
export function materializeSharedSkillPlugin(
  sourcePackDir: string,
  pluginName: string,
  skillNames: string[],
  targetDir: string,
): string | undefined {
  const sourcePluginDir = ensureSdkPluginLayout(sourcePackDir, pluginName);
  const selected = new Set(skillNames);
  const skills = scanSkillPack(sourcePluginDir).skills.filter((skill) => selected.has(skill.name));
  if (skills.length === 0) return undefined;

  rmSync(targetDir, { recursive: true, force: true });
  const targetSkillsDir = join(targetDir, "skills");
  mkdirSync(targetSkillsDir, { recursive: true });
  const usedNames = new Set<string>();
  for (const skill of skills) {
    const sourceDir = dirname(join(sourcePluginDir, skill.relativePath));
    const targetName = uniqueSkillDirectoryName(skill.name, usedNames);
    cpSync(sourceDir, join(targetSkillsDir, targetName), { recursive: true });
  }
  mkdirSync(join(targetDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(targetDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: pluginName, version: "0.1.0" }),
  );
  return targetDir;
}

function makeMarker(
  packDir: string,
  skills: Array<{ relativePath: string; name: string }>,
): LayoutMarker {
  return {
    version: 1,
    skills: skills.map((skill) => {
      const file = join(packDir, skill.relativePath);
      const stat = statSync(file);
      return {
        relativePath: skill.relativePath,
        name: skill.name,
        modifiedAt: stat.mtimeMs,
        size: stat.size,
      };
    }),
  };
}

function sameMarker(path: string, expected: LayoutMarker): boolean {
  if (!existsSync(path)) return false;
  try {
    return JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function uniqueSkillDirectoryName(name: string, usedNames: Set<string>): string {
  const base = name.replace(/[^a-zA-Z0-9._-]+/g, "-") || "skill";
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) candidate = `${base}-${suffix++}`;
  usedNames.add(candidate);
  return candidate;
}
