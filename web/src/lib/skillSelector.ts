import type { SkillGroupDTO } from "./agents";

export interface SkillSelectorOption {
  id: string;
  name: string;
  description?: string;
}

/** 树形勾选的分组视图（specs/2026-09-21-agent-config-llm-removal-skills-tree-design.md §4.2） */
export interface SkillSelectorGroup {
  key: string;
  label: string;
  kind: "system" | "pack" | "legacy";
  description?: string;
  sourceLabel?: string;
  options: SkillSelectorOption[];
}

/**
 * meta.skillGroups + 配置残留兜底组：agent.skills 中不在任何候选组的 id
 * （技能被卸载/停用/旧数据）聚成一组照常展示、可移除，配置不静默丢失。
 */
export function mergeSkillSelectorGroups(
  groups: SkillGroupDTO[],
  selected: string[],
): SkillSelectorGroup[] {
  const known = new Set(groups.flatMap((group) => group.skills.map((skill) => skill.id)));
  const legacy = selected
    .filter((id) => !known.has(id))
    .map((id) => ({ id, name: id, description: "当前候选列表中未发现，但会保留该配置" }));
  const out: SkillSelectorGroup[] = groups.map((group) => ({
    key: group.key,
    label: group.label,
    kind: group.kind,
    description: group.description,
    sourceLabel: group.sourceLabel,
    options: group.skills,
  }));
  if (legacy.length > 0) {
    out.push({
      key: "legacy",
      label: "配置残留（候选中不存在）",
      kind: "legacy",
      sourceLabel: "技能可能已被卸载或停用",
      options: legacy,
    });
  }
  return out;
}

/** 按关键词过滤各组技能行（组名也参与匹配）；无命中的组整组隐藏 */
export function filterSkillSelectorGroups(
  groups: SkillSelectorGroup[],
  query: string,
): SkillSelectorGroup[] {
  const keyword = query.trim().toLocaleLowerCase();
  if (!keyword) return groups;
  return groups
    .map((group) => ({
      ...group,
      options: group.options.filter((option) =>
        [option.id, option.name, option.description ?? "", group.label]
          .join(" ")
          .toLocaleLowerCase()
          .includes(keyword),
      ),
    }))
    .filter((group) => group.options.length > 0);
}

/** 默认 Skill 候选 = 已勾选技能（未勾选时为全量候选） */
export function getDefaultSkillOptions(
  options: SkillSelectorOption[],
  selectedSkills: string[],
): SkillSelectorOption[] {
  if (selectedSkills.length === 0) return options;
  const selected = new Set(selectedSkills);
  return options.filter((option) => selected.has(option.id));
}
