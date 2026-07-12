import type { PackSkill, SkillPack } from "./skill-pack.js";

export interface ResolvedSkills {
  pluginPaths: string[]; // 已 resolve（绝对/共享）的 pack 路径，去重
  whitelist: string[]; // pluginName:skillName
  declaredCredentialKeys: string[]; // 启用 pack 声明的所有 key（去重）
  requiredCredentialKeys: string[]; // 仅 required（去重）
}

/**
 * 由启用 Pack/Skill 派生运行时所需：pluginPaths、技能白名单、需注入的凭证 key。
 * pathResolver：用户 pack 把相对 homeDir 的 installedPath → 绝对；预装通常已是绝对，原样返回。
 */
export function resolveActiveSkills(
  packs: SkillPack[],
  skillsByPack: Map<string, PackSkill[]>,
  pathResolver: (pack: SkillPack) => string,
): ResolvedSkills {
  const pluginPaths: string[] = [];
  const whitelist: string[] = [];
  const declared: string[] = [];
  const required: string[] = [];
  for (const p of packs) {
    if (!p.enabled) continue;
    const path = pathResolver(p);
    if (!pluginPaths.includes(path)) pluginPaths.push(path);
    for (const c of p.credentials) {
      if (!declared.includes(c.key)) declared.push(c.key);
      if (c.required && !required.includes(c.key)) required.push(c.key);
    }
    const skills = skillsByPack.get(p.id) ?? [];
    for (const s of skills) {
      if (s.enabled) whitelist.push(`${p.name}:${s.name}`);
    }
  }
  return {
    pluginPaths,
    whitelist,
    declaredCredentialKeys: declared,
    requiredCredentialKeys: required,
  };
}
