export interface SkillSelectorOption {
  id: string;
  name: string;
  description?: string;
}

export function mergeSkillSelectorOptions(
  options: SkillSelectorOption[],
  selected: string[],
): SkillSelectorOption[] {
  const known = new Set(options.map((option) => option.id));
  const legacy = selected
    .filter((id) => !known.has(id))
    .map((id) => ({ id, name: id, description: "当前候选列表中未发现，但会保留该配置" }));
  return [...options, ...legacy];
}

export function filterSkillSelectorOptions(
  options: SkillSelectorOption[],
  query: string,
): SkillSelectorOption[] {
  const keyword = query.trim().toLocaleLowerCase();
  if (!keyword) return options;
  return options.filter((option) =>
    [option.id, option.name, option.description ?? ""]
      .join(" ")
      .toLocaleLowerCase()
      .includes(keyword),
  );
}

export function getDefaultSkillOptions(
  options: SkillSelectorOption[],
  selectedSkills: string[],
): SkillSelectorOption[] {
  if (selectedSkills.length === 0) return options;
  const selected = new Set(selectedSkills);
  return options.filter((option) => selected.has(option.id));
}
