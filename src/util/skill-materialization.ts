// 平台技能白名单物化（codex/zcode 引擎共用，specs/2026-10-09-skills-git-hosting-design.md G5）：
// 两引擎都无 claude SDK 的 plugins 直挂通道，改走各自的原生技能目录——
// codex = CODEX_HOME/skills，zcode = <重定向HOME>/.zcode/skills（bundle 实证
// resolveDefaultSkillRoots 的用户级根，目录名即技能名）。
// 白名单语义：仅复制 opts.skills 勾选（packName:skillName）且 pack 启用的技能；
// 单技能失败不阻断运行（缺该技能仅能力降级）。

import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scanSkillPack } from "../domain/skill-scan.js";

export function materializeWhitelistedSkills(
  skills: string[],
  pluginPaths: string[],
  skillsHome: string,
): void {
  if (skills.length === 0 || pluginPaths.length === 0) return;
  const wanted = new Map<string, Set<string>>();
  for (const id of skills) {
    const sep = id.indexOf(":");
    if (sep <= 0 || sep === id.length - 1) continue;
    const packName = id.slice(0, sep);
    const skillName = id.slice(sep + 1);
    const set = wanted.get(packName) ?? new Set<string>();
    set.add(skillName);
    wanted.set(packName, set);
  }
  if (wanted.size === 0) return;

  for (const pluginPath of pluginPaths) {
    if (!existsSync(pluginPath)) continue;
    const packName = readPluginName(pluginPath);
    const selected = packName ? wanted.get(packName) : undefined;
    if (!selected || selected.size === 0) continue;
    let scanned: ReturnType<typeof scanSkillPack>;
    try {
      scanned = scanSkillPack(pluginPath);
    } catch {
      continue;
    }
    for (const skill of scanned.skills) {
      if (!selected.has(skill.name)) continue;
      const sourceDir = join(pluginPath, skill.relativePath, "..");
      const target = join(skillsHome, skill.name);
      rmSync(target, { recursive: true, force: true });
      try {
        cpSync(sourceDir, target, { recursive: true });
      } catch {
        // 单技能物化失败不阻断运行（缺该技能仅能力降级）
      }
    }
  }
}

function readPluginName(pluginPath: string): string | undefined {
  const marker = join(pluginPath, ".claude-plugin", "plugin.json");
  if (!existsSync(marker)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(marker, "utf8")) as { name?: string };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}
