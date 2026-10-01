import { isAbsolute, join } from "node:path";
import { ensureSdkPluginLayout } from "../util/sdk-plugin-layout.js";
import type { SkillPack } from "./skill-pack.js";
import { scanSkillPack } from "./skill-scan.js";

/**
 * 技能可用性对账（静默缺失治理，2026-10-01 共享智能体技能修复轮）：
 * 智能体声明的技能（agent.skills/defaultSkill，"pack:skill" 格式）与属主侧
 * 实际可加载的技能（enabled pack + 磁盘 scan 到的 frontmatter name）做差集。
 * 返回缺失清单（原格式 skillId）；对账是纯读，不写盘、不物化。
 */
export function auditAgentSkillAvailability(
  listPacks: (userId: string) => Promise<SkillPack[]>,
  agent: { skills: string[]; defaultSkill?: string },
  skillOwner: { id: string; homeDir: string },
): Promise<string[]> {
  const declared = new Map<string, Set<string>>();
  const missing: string[] = [];
  const collect = (skillId: string) => {
    const separator = skillId.indexOf(":");
    // 无法定位 pack 的条目直接记缺失（无法解析即不可加载）
    if (separator <= 0 || separator === skillId.length - 1) {
      missing.push(skillId);
      return;
    }
    const packName = skillId.slice(0, separator);
    const names = declared.get(packName) ?? new Set<string>();
    names.add(skillId.slice(separator + 1));
    declared.set(packName, names);
  };
  for (const skillId of agent.skills) collect(skillId);
  if (agent.defaultSkill) collect(agent.defaultSkill);
  if (declared.size === 0) return Promise.resolve(missing);

  return listPacks(skillOwner.id).then((packs) => {
    const byName = new Map(packs.filter((p) => p.enabled).map((p) => [p.name, p]));
    for (const [packName, skillNames] of declared) {
      const pack = byName.get(packName);
      if (!pack) {
        for (const s of skillNames) missing.push(`${packName}:${s}`);
        continue;
      }
      let available: Set<string>;
      try {
        const packPath = resolvePackDirectory(pack, skillOwner.homeDir);
        available = new Set(scanSkillPack(packPath).skills.map((s) => s.name));
      } catch {
        available = new Set();
      }
      for (const s of skillNames) {
        if (!available.has(s)) missing.push(`${packName}:${s}`);
      }
    }
    return missing;
  });
}

/** pack 绝对路径解析：预装/绝对路径原样，用户 pack 拼 homeDir（与 RuntimeManager.resolvePackPath 同语义） */
export function resolvePackDirectory(pack: SkillPack, homeDir: string): string {
  const packPath =
    pack.builtin || isAbsolute(pack.installedPath)
      ? pack.installedPath
      : join(homeDir, pack.installedPath);
  return ensureSdkPluginLayout(packPath, pack.name);
}
