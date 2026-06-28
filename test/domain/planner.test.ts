import { describe, expect, it } from "vitest";
import { Planner } from "../../src/domain/planner.js";

describe("Planner", () => {
  const p = new Planner();

  it("命中代码意图 → 返回 superpowers 编码能力包", () => {
    const plan = p.plan("给 plato 加个导出 CSV 接口");
    expect(plan.intent).toBe("code");
    expect(plan.skills).toContain("superpowers:brainstorming");
    expect(plan.skills).toContain("superpowers:test-driven-development");
    expect(plan.skills.length).toBe(8);
  });

  it("命中 bug 关键词 → code 意图", () => {
    expect(p.plan("帮我修个 bug").intent).toBe("code");
  });

  it("未命中 → unknown + 空 skills", () => {
    const plan = p.plan("今天天气怎么样");
    expect(plan.intent).toBe("unknown");
    expect(plan.skills).toEqual([]);
  });

  it("返回的 skills 是副本，外部改动不影响后续 plan", () => {
    const plan = p.plan("实现一个函数");
    plan.skills.push("xxx");
    const again = p.plan("实现一个函数");
    expect(again.skills).not.toContain("xxx");
    expect(again.skills.length).toBe(8);
  });

  it("可注入自定义 intents（替换默认）", () => {
    const p2 = new Planner([{ name: "ops", triggers: ["部署", "回滚"], skills: ["opser"] }]);
    expect(p2.plan("执行部署").intent).toBe("ops");
    expect(p2.plan("实现代码").intent).toBe("unknown");
  });
});
