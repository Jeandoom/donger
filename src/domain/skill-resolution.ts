import type { PackSkill, SkillPack } from "./skill-pack.js";

export interface ResolvedSkills {
  pluginPaths: string[]; // 已 resolve（绝对/共享）的 pack 路径，去重
  whitelist: string[]; // pluginName:skillName
}

/**
 * 由启用 Pack/Skill 派生运行时所需：pluginPaths、技能白名单。
 * pathResolver：用户 pack 把相对 homeDir 的 installedPath → 绝对；预装通常已是绝对，原样返回。
 */
export function resolveActiveSkills(
  packs: SkillPack[],
  skillsByPack: Map<string, PackSkill[]>,
  pathResolver: (pack: SkillPack) => string,
): ResolvedSkills {
  const pluginPaths: string[] = [];
  const whitelist: string[] = [];
  for (const p of packs) {
    if (!p.enabled) continue;
    const path = pathResolver(p);
    if (!pluginPaths.includes(path)) pluginPaths.push(path);
    const skills = skillsByPack.get(p.id) ?? [];
    for (const s of skills) {
      if (s.enabled) whitelist.push(`${p.name}:${s.name}`);
    }
  }
  return { pluginPaths, whitelist };
}
