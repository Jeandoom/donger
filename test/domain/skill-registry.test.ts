import { describe, expect, it } from "vitest";
import { SkillRegistry } from "../../src/domain/skill-registry.js";

describe("SkillRegistry", () => {
  it("register/get/has/all 基本用法", () => {
    const r = new SkillRegistry();
    r.register({
      id: "code-task-design",
      kind: "markdown",
      description: "d",
      triggers: ["代码", "实现", "bug"],
    });
    expect(r.has("code-task-design")).toBe(true);
    expect(r.has("nope")).toBe(false);
    expect(r.get("code-task-design")?.id).toBe("code-task-design");
    expect(r.get("nope")).toBeUndefined();
    expect(r.all()).toHaveLength(1);
  });

  it("重复 id 抛错", () => {
    const r = new SkillRegistry();
    r.register({ id: "x", kind: "markdown", description: "d" });
    expect(() => r.register({ id: "x", kind: "code", description: "d2" })).toThrow();
  });

  it("findByTrigger 大小写不敏感子串匹配", () => {
    const r = new SkillRegistry();
    r.register({ id: "a", kind: "markdown", description: "d", triggers: ["BUG", "修复"] });
    r.register({ id: "b", kind: "markdown", description: "d", triggers: ["部署"] });
    expect(r.findByTrigger("帮我修个 bug").map((s) => s.id)).toEqual(["a"]);
    expect(r.findByTrigger("执行部署").map((s) => s.id)).toEqual(["b"]);
    expect(r.findByTrigger("今天天气")).toEqual([]);
  });

  it("无 triggers 的 skill 不被 findByTrigger 命中", () => {
    const r = new SkillRegistry();
    r.register({ id: "c", kind: "markdown", description: "d" });
    expect(r.findByTrigger("anything")).toEqual([]);
  });
});
