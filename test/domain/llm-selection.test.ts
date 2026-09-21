import { describe, expect, it } from "vitest";
import { resolveLlmOptions } from "../../src/domain/llm-selection.js";
import { isModelRef, parseModelRef } from "../../src/domain/model-ref.js";

const PROVIDERS = [
  { id: "p1", name: "我的智谱", models: ["glm-4.6", "glm-4.5"] },
  { id: "p2", name: "DS", models: ["deepseek-chat"] },
];
const PRESETS = [{ id: "0", name: "GLM", model: "glm-4.6" }];
const BASE = {
  providers: PROVIDERS,
  presets: PRESETS,
  systemDefaultModel: "glm-4.6",
};

describe("parseModelRef", () => {
  it("三种合法形态", () => {
    expect(parseModelRef("system")).toEqual({ kind: "system" });
    expect(parseModelRef("preset:0")).toEqual({ kind: "preset", id: "0" });
    expect(parseModelRef("provider:p1:glm-4.6")).toEqual({
      kind: "provider",
      providerId: "p1",
      model: "glm-4.6",
    });
  });
  it("非法形态返回 undefined", () => {
    for (const raw of [
      "",
      "preset:",
      "provider:",
      "provider:p1:",
      "provider::m",
      "foo:bar",
      "system:x",
    ]) {
      expect(parseModelRef(raw), raw).toBeUndefined();
    }
    expect(isModelRef("provider:p1:glm-4.6")).toBe(true);
    expect(isModelRef("bad")).toBe(false);
  });
});

describe("resolveLlmOptions", () => {
  it("恒为全量：system + presets + 当前用户 provider 模型（agent 侧范围已退役）", () => {
    const options = resolveLlmOptions(BASE);
    expect(options.map((o) => o.ref)).toEqual([
      "system",
      "preset:0",
      "provider:p1:glm-4.6",
      "provider:p1:glm-4.5",
      "provider:p2:deepseek-chat",
    ]);
  });

  it("无系统默认模型时不输出 system 项", () => {
    const options = resolveLlmOptions({ ...BASE, systemDefaultModel: "" });
    expect(options.map((o) => o.ref)).toEqual([
      "preset:0",
      "provider:p1:glm-4.6",
      "provider:p1:glm-4.5",
      "provider:p2:deepseek-chat",
    ]);
  });

  it("provider 清单为空时仍输出 system + presets", () => {
    const options = resolveLlmOptions({ providers: [], presets: PRESETS, systemDefaultModel: "m" });
    expect(options.map((o) => o.ref)).toEqual(["system", "preset:0"]);
  });
});
