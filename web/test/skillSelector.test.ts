import { describe, expect, it } from "vitest";
import {
  filterSkillSelectorOptions,
  getDefaultSkillOptions,
  mergeSkillSelectorOptions,
} from "../src/lib/skillSelector";

const options = [
  { id: "superpowers:brainstorming", name: "brainstorming", description: "探索方案" },
  { id: "aliyun:sls-query", name: "SLS 查询", description: "查询和分析日志" },
];

describe("skillSelector", () => {
  it("按 id、名称和描述进行大小写不敏感的模糊匹配", () => {
    expect(filterSkillSelectorOptions(options, "日志").map((item) => item.id)).toEqual([
      "aliyun:sls-query",
    ]);
    expect(filterSkillSelectorOptions(options, "BRAIN").map((item) => item.id)).toEqual([
      "superpowers:brainstorming",
    ]);
  });

  it("保留历史中不存在于候选列表的技能，并避免重复", () => {
    const merged = mergeSkillSelectorOptions(options, ["legacy:skill", "aliyun:sls-query"]);
    expect(merged.map((item) => item.id)).toEqual([
      "superpowers:brainstorming",
      "aliyun:sls-query",
      "legacy:skill",
    ]);
  });

  it("默认 Skill 有已选技能时仅显示已选项，否则显示全部候选", () => {
    expect(getDefaultSkillOptions(options, ["aliyun:sls-query"]).map((item) => item.id)).toEqual([
      "aliyun:sls-query",
    ]);
    expect(getDefaultSkillOptions(options, []).map((item) => item.id)).toEqual([
      "superpowers:brainstorming",
      "aliyun:sls-query",
    ]);
  });
});
