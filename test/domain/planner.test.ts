import { describe, expect, it } from "vitest";
import { Planner } from "../../src/domain/planner.js";

describe("Planner", () => {
  const p = new Planner();

  it("命中代码意图 → code", () => {
    expect(p.plan("给 plato 加个导出 CSV 接口").intent).toBe("code");
  });

  it("命中 bug 关键词 → code 意图", () => {
    expect(p.plan("帮我修个 bug").intent).toBe("code");
  });

  it("未命中 → general（通用对话，仍走 agent）", () => {
    expect(p.plan("今天天气怎么样").intent).toBe("general");
  });

  it("可注入自定义 intents（替换默认）", () => {
    const p2 = new Planner([{ name: "ops", triggers: ["部署", "回滚"] }]);
    expect(p2.plan("执行部署").intent).toBe("ops");
    expect(p2.plan("实现代码").intent).toBe("general");
  });
});
