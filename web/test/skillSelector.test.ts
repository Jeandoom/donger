import { describe, expect, it } from "vitest";
import type { SkillGroupDTO } from "../src/lib/agents";
import {
  filterSkillSelectorGroups,
  getDefaultSkillOptions,
  mergeSkillSelectorGroups,
} from "../src/lib/skillSelector";

const groups: SkillGroupDTO[] = [
  {
    key: "builtin",
    label: "系统内置",
    kind: "system",
    skills: [{ id: "web-ui-iterate", name: "web-ui-iterate", description: "页面迭代" }],
  },
  {
    key: "pack:p1",
    label: "superpowers",
    kind: "pack",
    sourceLabel: "Git 仓库（https://example.com/s.git）",
    skills: [
      { id: "superpowers:brainstorming", name: "brainstorming", description: "探索方案" },
      { id: "superpowers:review", name: "review", description: "评审代码" },
    ],
  },
];

describe("skillSelector（树形分组）", () => {
  it("分组合并：meta 分组原样保留，已存但不在候选的 id 聚成配置残留组", () => {
    const merged = mergeSkillSelectorGroups(groups, ["superpowers:brainstorming", "legacy:skill"]);
    expect(merged.map((group) => group.key)).toEqual(["builtin", "pack:p1", "legacy"]);
    expect(merged[2]?.options.map((option) => option.id)).toEqual(["legacy:skill"]);
  });

  it("无残留时不产生配置残留组", () => {
    expect(mergeSkillSelectorGroups(groups, ["superpowers:review"]).map((g) => g.key)).toEqual([
      "builtin",
      "pack:p1",
    ]);
  });

  it("按技能名/描述/组名大小写不敏感过滤，无命中组整组隐藏", () => {
    const filtered = filterSkillSelectorGroups(mergeSkillSelectorGroups(groups, []), "日志");
    expect(filtered.map((group) => group.key)).toEqual([]);
    expect(
      filterSkillSelectorGroups(mergeSkillSelectorGroups(groups, []), "评审").map(
        (group) => group.key,
      ),
    ).toEqual(["pack:p1"]);
    expect(
      filterSkillSelectorGroups(mergeSkillSelectorGroups(groups, []), "SUPERPOWERS")[0]?.options
        .length,
    ).toBe(2);
  });

  it("默认 Skill 有已选技能时仅显示已选项，否则显示全部候选", () => {
    const all = mergeSkillSelectorGroups(groups, []).flatMap((group) => group.options);
    expect(
      getDefaultSkillOptions(all, ["superpowers:brainstorming"]).map((option) => option.id),
    ).toEqual(["superpowers:brainstorming"]);
    expect(getDefaultSkillOptions(all, []).map((option) => option.id)).toEqual([
      "web-ui-iterate",
      "superpowers:brainstorming",
      "superpowers:review",
    ]);
  });
});
